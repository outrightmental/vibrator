import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";



/**
 * Local Claude coding-agent client. The default implementation shells out
 * to the `claude` CLI (Claude Code) inside a fresh checkout of the
 * repository / pull request branch so the CLI can read, modify, commit,
 * and (where applicable) push code.
 *
 * Every operation runs synchronously: `vibrator` waits for Claude to
 * finish, then continues the loop. This client opens the PR itself when
 * implementing an issue.
 */
export interface ClaudeAgentClient {
  implementIssue(params: ImplementIssueParams): Promise<ImplementIssueResult>;
  selfReview(params: SelfReviewParams): Promise<SelfReviewResult>;
  resolveMergeConflicts(
    params: ResolveMergeConflictsParams,
  ): Promise<AgentBranchUpdate>;
  addressFailingChecks(
    params: AddressFailingChecksParams,
  ): Promise<AgentBranchUpdate>;
  generateFinalDescription(
    params: GenerateFinalDescriptionParams,
  ): Promise<string>;
}

export interface ImplementIssueParams {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** Default branch name to base the new feature branch on. */
  baseBranch: string;
}

export interface ImplementIssueResult {
  /** Name of the branch the agent pushed commits to (e.g. `vibrator/issue-42-…`). */
  branch: string;
  /** Title for the new pull request. */
  pullRequestTitle: string;
  /** Body for the new pull request. */
  pullRequestBody: string;
  /** SHA of the latest pushed commit on `branch`. */
  headSha: string;
}

export interface SelfReviewParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestBody: string;
  /** Branch the PR is opened from. */
  headRefName: string;
  /** Branch the PR targets. */
  baseRefName: string;
  /** The issue this PR is intended to resolve — used to scope the review. */
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
}

export interface SelfReviewResult {
  /**
   * True when the self-review found issues and committed fixes to the
   * branch. False when the code was already satisfactory and nothing was
   * changed.
   */
  madeChanges: boolean;
  /** SHA of the latest commit on the branch after the review pass. */
  headSha: string;
}

export interface ResolveMergeConflictsParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headRefName: string;
  baseRefName: string;
}

export interface AddressFailingChecksParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headRefName: string;
  baseRefName: string;
  /** Names + brief log summaries of the failing checks. */
  failingChecks: ReadonlyArray<{
    name: string;
    logExcerpt: string;
  }>;
}

export interface GenerateFinalDescriptionParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestBody: string;
  headRefName: string;
  baseRefName: string;
  closingIssueNumbers: readonly number[];
}

export interface AgentBranchUpdate {
  /** SHA of the latest commit on the branch after the agent pushed. */
  headSha: string;
}

/**
 * Sentinel markers wrapping the final PR description in `claude` CLI
 * output. The CLI typically interleaves the description with tool-call
 * transcript chatter, so we instruct it (via the prompt) to emit the
 * description exactly between these sentinels.
 */
export const FINAL_DESCRIPTION_START_MARKER = "<<<VIBRATOR_PR_BODY_START>>>";
export const FINAL_DESCRIPTION_END_MARKER = "<<<VIBRATOR_PR_BODY_END>>>";

/**
 * Sentinel markers wrapping the JSON implementation-summary payload
 * (PR title + body) the Claude implementer must emit.
 */
export const IMPLEMENTATION_PAYLOAD_START_MARKER = "<<<VIBRATOR_IMPL_START>>>";
export const IMPLEMENTATION_PAYLOAD_END_MARKER = "<<<VIBRATOR_IMPL_END>>>";

interface ClaudeAgentClientOptions {
  /** Root directory under which per-PR / per-issue checkouts are created. */
  checkoutRootDir?: string;
  /** Path / command for the local `claude` CLI. */
  claudeCommand?: string;
  /** Path / command for the `gh` CLI used to fetch PR branches. */
  ghCommand?: string;
  /** Model to pass to the claude CLI via --model. When omitted, falls back to CLAUDE_MODEL env. */
  claudeModel?: string;
  /**
   * Maximum milliseconds the Claude CLI is allowed to run before being killed.
   * Defaults to CLAUDE_TIMEOUT_MS env var, or 30 minutes if unset.
   */
  claudeTimeoutMs?: number;
}

function defaultCheckoutRootDir(): string {
  return join(homedir(), ".vibrator", "checkouts");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function isRebaseInProgress(
  repoDir: string,
  pathExistsFn: (path: string) => Promise<boolean> = pathExists,
): Promise<boolean> {
  return (
    (await pathExistsFn(join(repoDir, ".git", "rebase-merge"))) ||
    (await pathExistsFn(join(repoDir, ".git", "rebase-apply")))
  );
}

interface RunCommandOptions {
  cwd?: string;
  input?: string;
  captureStdout?: boolean;
  /** Capture stderr and include it in non-zero-exit error messages. */
  captureStderr?: boolean;
  /** Called with each decoded stdout chunk as it arrives (requires captureStdout: true). */
  onStdoutChunk?: (chunk: string) => void;
  /**
   * Called with each decoded stderr chunk as it arrives. When set, stderr is
   * piped (rather than inherited) and each chunk is forwarded to
   * process.stderr so nothing is lost.
   */
  onStderrChunk?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
  /**
   * If set, the child process is killed with SIGTERM (then SIGKILL after 5 s)
   * and the promise rejects with a timeout error after this many milliseconds.
   */
  timeoutMs?: number;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [
        options.input !== undefined ? "pipe" : "inherit",
        options.captureStdout ? "pipe" : "inherit",
        options.onStderrChunk || options.captureStderr ? "pipe" : "inherit",
      ],
    });

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    if (options.timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Escalate to SIGKILL after 5 s if SIGTERM did not work.
        setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
      }, options.timeoutMs);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    if (options.captureStdout && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        options.onStdoutChunk?.(chunk.toString("utf8"));
      });
    }

    if ((options.onStderrChunk || options.captureStderr) && child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        if (options.onStderrChunk) {
          process.stderr.write(chunk);
          options.onStderrChunk(chunk.toString("utf8"));
        }
        if (options.captureStderr) {
          stderrChunks.push(chunk);
        }
      });
    }

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");

      const summarizeOutput = (text: string): string => {
        const trimmed = text.trim();
        if (!trimmed) return "";
        const limit = 1500;
        return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed;
      };

      const outputSummary = summarizeOutput(stderrText) || summarizeOutput(stdoutText);

      if (timedOut) {
        reject(
          new Error(
            `Command \`${command} ${args.join(" ")}\` timed out after ${options.timeoutMs! / 1000}s and was killed.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Command \`${command} ${args.join(" ")}\` exited with non-zero status ${code ?? "unknown"}.` +
              (outputSummary ? `\n${outputSummary}` : ""),
          ),
        );
        return;
      }
      resolve(stdoutText);
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

function extractBetweenMarkers(
  rawOutput: string,
  start: string,
  end: string,
): string | undefined {
  const startIndex = rawOutput.indexOf(start);
  const endIndex = rawOutput.lastIndexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }
  return rawOutput
    .slice(startIndex + start.length, endIndex)
    .replace(/^\s*\r?\n/, "")
    .replace(/\r?\n\s*$/, "")
    .trim();
}

export function extractFinalDescription(rawOutput: string): string {
  const inner = extractBetweenMarkers(
    rawOutput,
    FINAL_DESCRIPTION_START_MARKER,
    FINAL_DESCRIPTION_END_MARKER,
  );
  return inner ?? rawOutput.trim();
}

export function extractImplementationPayload(
  rawOutput: string,
): { pullRequestTitle: string; pullRequestBody: string } | undefined {
  const inner = extractBetweenMarkers(
    rawOutput,
    IMPLEMENTATION_PAYLOAD_START_MARKER,
    IMPLEMENTATION_PAYLOAD_END_MARKER,
  );
  if (!inner) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(inner);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const obj = data as Record<string, unknown>;
  if (typeof obj.title !== "string" || typeof obj.body !== "string") {
    return undefined;
  }
  return { pullRequestTitle: obj.title, pullRequestBody: obj.body };
}

function buildImplementationPrompt(params: ImplementIssueParams, branch: string): string {
  return [
    `You are implementing GitHub issue #${params.issueNumber} in the repository ${params.owner}/${params.repo}.`,
    "",
    `Issue title: ${params.issueTitle}`,
    "",
    "Issue body:",
    "---",
    params.issueBody || "(empty)",
    "---",
    "",
    "Working directory: the current directory is a checkout of the repository, with",
    `branch \`${branch}\` already checked out (it is based on \`${params.baseBranch}\`).`,
    "",
    "Instructions:",
    `1. Implement the change required by issue #${params.issueNumber}. Read the existing code, make the necessary edits, and add or update tests when relevant.`,
    "2. Commit every change you make to the current branch with descriptive commit messages.",
    "3. After all commits are made, output a JSON object containing the proposed pull-request title and body, wrapped between the exact sentinel lines below.",
    "",
    `${IMPLEMENTATION_PAYLOAD_START_MARKER}`,
    `{`,
    `  "title": "<concise PR title summarizing the change>",`,
    `  "body": "<Markdown PR body describing what changed, why, and how it was tested. Include a 'Closes #${params.issueNumber}' line.>"`,
    `}`,
    `${IMPLEMENTATION_PAYLOAD_END_MARKER}`,
    "",
    "Output requirements:",
    "- The JSON object must be valid and appear exactly once, between the sentinel markers on their own lines.",
    "- Do not wrap the JSON in code fences.",
    "- Anything written outside the sentinels is treated as transcript and discarded.",
  ].join("\n");
}

function buildSelfReviewPrompt(params: SelfReviewParams): string {
  const issueSection =
    params.issueNumber !== undefined
      ? [
          "",
          `This PR was created to resolve issue #${params.issueNumber}: ${params.issueTitle ?? "(no title)"}`,
          "",
          "Issue description:",
          "---",
          params.issueBody || "(empty)",
          "---",
        ]
      : [];

  return [
    `You are performing a self-review of pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `PR title: ${params.pullRequestTitle}`,
    `Branch: \`${params.headRefName}\` (targets \`${params.baseRefName}\`).`,
    ...issueSection,
    "",
    "Current PR description:",
    "---",
    params.pullRequestBody || "(empty)",
    "---",
    "",
    "Instructions:",
    `1. Read the full diff (\`git diff origin/${params.baseRefName}..HEAD\`) and the surrounding code carefully.`,
    `2. Evaluate the changes strictly against the requirements in issue #${params.issueNumber !== undefined ? params.issueNumber : "(above)"}. Only flag problems that are relevant to what this issue asked for: bugs, missing requirements, broken or missing tests, security issues, or significant design problems within the scope of this change. Do not comment on pre-existing code or unrelated areas.`,
    "3. If you find any problems, fix them directly by editing the files. Commit every change with a clear, descriptive commit message that explains what was changed and why.",
    "4. If you find nothing that needs to change, make no commits and output only a brief 'LGTM' message.",
    "",
    "Be honest and thorough — this is your own code and the goal is to ship high-quality work that fully satisfies the issue.",
  ].join("\n");
}

function buildResolveConflictsPrompt(params: ResolveMergeConflictsParams): string {
  return [
    `You are resolving merge conflicts on pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `The current branch \`${params.headRefName}\` has been rebased onto \`origin/${params.baseRefName}\` and is in a conflicted state (or about to be — run \`git status\` first).`,
    "",
    "Instructions:",
    "1. Inspect the conflicts (`git status`, `git diff --check`).",
    "2. Resolve each conflict by editing the files so the resulting code is correct and integrates both sides of the merge meaningfully.",
    "3. `git add` the resolved files and commit (either continue the rebase with `git rebase --continue` or, if a non-rebase merge is in progress, `git commit`).",
    "4. Do not push — the orchestrator handles pushing.",
    "",
    "If you cannot resolve a conflict safely, abort the rebase/merge (`git rebase --abort` / `git merge --abort`) and exit with a clear explanation.",
  ].join("\n");
}

function buildAddressFailingChecksPrompt(params: AddressFailingChecksParams): string {
  const checkList = params.failingChecks
    .map((c, i) => `### ${i + 1}. ${c.name}\n\n${c.logExcerpt}`)
    .join("\n\n");
  return [
    `Status checks are failing on pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `Branch: \`${params.headRefName}\` (targets \`${params.baseRefName}\`).`,
    "",
    "Failing checks (name + log excerpt):",
    "---",
    checkList || "(no failing-check details were captured — investigate with `gh pr checks` and `gh run view`)",
    "---",
    "",
    "Instructions:",
    "1. Diagnose the failure(s) by reading the code referenced in the logs.",
    "2. Fix the underlying problem. Re-run the tests/linters locally if available.",
    "3. Commit every change with a descriptive commit message.",
    "4. Do not push — the orchestrator handles pushing.",
  ].join("\n");
}

function buildFinalDescriptionPrompt(params: GenerateFinalDescriptionParams): string {
  const closingReferences =
    params.closingIssueNumbers.length === 0
      ? ""
      : `\n\nThe final description must end with these closing references on their own lines (inside the markers, before the end marker) so GitHub auto-closes the linked issues:\n${params.closingIssueNumbers
          .map((issueNumber) => `Closes #${issueNumber}`)
          .join("\n")}`;

  return [
    `You are writing the final pull-request description for PR #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `Read the commits and diff on the current branch (use \`git log\`, \`git diff origin/${params.baseRefName}..HEAD\`, etc.) and produce a polished, accurate Markdown description summarizing what changed and why.`,
    "",
    `Current PR title: ${params.pullRequestTitle}`,
    "",
    "Current PR description (may be a placeholder — replace as needed):",
    "---",
    params.pullRequestBody || "(empty)",
    "---",
    "",
    "Output requirements:",
    `- Emit the final PR description wrapped between the exact sentinel lines \`${FINAL_DESCRIPTION_START_MARKER}\` and \`${FINAL_DESCRIPTION_END_MARKER}\`, each on its own line.`,
    "- The content between the sentinels MUST be ONLY the Markdown body of the new PR description — no preamble, no recap, no tool transcript, no code fences wrapping the whole thing.",
    "- Do not include the PR title.",
    "- The sentinel markers must appear exactly once each in your entire output.",
    "- Anything you write outside the sentinels will be discarded, so put the complete final description between them.",
    closingReferences,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function slugifyIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_QUOTA_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes

let claudeQuotaBlockedUntilMs: number | undefined;

export function isClaudeUsageLimitMessage(message: string): boolean {
  return /out of extra usage|out of usage|hit your limit|rate limit|quota|usage limit/i.test(
    message,
  );
}

/**
 * Parse a quota-reset timestamp from Claude CLI output.
 *
 * Supported examples:
 * - "resets 6:40pm (America/Los_Angeles)"
 * - "reset at 10:15 AM"
 *
 * Returns an epoch-millis timestamp in local time, or undefined if parsing fails.
 */
export function parseUsageResetTimeMs(message: string, now: Date = new Date()): number | undefined {
  const match = message.match(/\breset(?:s)?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap]m)\b/i);
  if (!match) {
    return undefined;
  }

  const rawHour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  const period = match[3]!.toLowerCase();

  if (Number.isNaN(rawHour) || Number.isNaN(minute) || rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
    return undefined;
  }

  const hours24 = (rawHour % 12) + (period === "pm" ? 12 : 0);
  const reset = new Date(now);
  reset.setSeconds(0, 0);
  reset.setHours(hours24, minute, 0, 0);

  if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }

  return reset.getTime();
}

function formatLocalTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    month: "short",
    day: "numeric",
  });
}

class DefaultClaudeAgentClient implements ClaudeAgentClient {
  private readonly checkoutRootDir: string;
  private readonly claudeCommand: string;
  private readonly ghCommand: string;
  private readonly claudeModel: string | undefined;
  private readonly claudeTimeoutMs: number;

  constructor(options: ClaudeAgentClientOptions = {}) {
    this.checkoutRootDir = options.checkoutRootDir ?? defaultCheckoutRootDir();
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.ghCommand = options.ghCommand ?? "gh";
    this.claudeModel = options.claudeModel ?? process.env.CLAUDE_MODEL;
    const envTimeout = process.env.CLAUDE_TIMEOUT_MS;
    this.claudeTimeoutMs =
      options.claudeTimeoutMs ??
      (envTimeout !== undefined ? Number.parseInt(envTimeout, 10) : DEFAULT_CLAUDE_TIMEOUT_MS);
  }

  async implementIssue(params: ImplementIssueParams): Promise<ImplementIssueResult> {
    const branch = `vibrator/issue-${params.issueNumber}-${slugifyIssueTitle(params.issueTitle)}`;
    const repoDir = await this.checkoutBaseBranch({
      owner: params.owner,
      repo: params.repo,
      baseBranch: params.baseBranch,
      identifier: `issue-${params.issueNumber}`,
    });

    // Create or reset the feature branch from the up-to-date base.
    await runCommand("git", ["checkout", "-B", branch, `origin/${params.baseBranch}`], {
      cwd: repoDir,
    });

    const prompt = buildImplementationPrompt(params, branch);
    const stdout = await this.runClaude(prompt, repoDir);
    const payload = extractImplementationPayload(stdout);

    // Safety net: if Claude edited files but did not commit them (e.g. because
    // the permission mode previously blocked bash commands), commit everything
    // now so the push is never empty.
    const uncommitted = (
      await runCommand("git", ["status", "--porcelain"], {
        cwd: repoDir,
        captureStdout: true,
      })
    ).trim();
    if (uncommitted) {
      console.warn(
        `[vibrator] Claude left uncommitted changes after implementation — committing automatically.`,
      );
      await runCommand("git", ["add", "--all"], { cwd: repoDir });
      await runCommand(
        "git",
        ["commit", "-m", `Implement #${params.issueNumber}: ${params.issueTitle}`],
        { cwd: repoDir },
      );
    }

    // Guard: if the branch has zero commits ahead of the base, Claude
    // produced no implementation. Fail early instead of pushing an empty
    // branch and hitting a GitHub 422 when we try to open the PR.
    const commitsAhead = (
      await runCommand(
        "git",
        ["rev-list", "--count", `origin/${params.baseBranch}..HEAD`],
        { cwd: repoDir, captureStdout: true },
      )
    ).trim();
    if (commitsAhead === "0") {
      throw new Error(
        `Claude produced no commits for issue #${params.issueNumber} ("${params.issueTitle}"). ` +
        `The branch "${branch}" has no changes relative to "${params.baseBranch}".`,
      );
    }

    // Merge latest from base branch using 'theirs' strategy before pushing.
    await runCommand("git", ["fetch", "origin", params.baseBranch], { cwd: repoDir });
    try {
      await runCommand("git", ["merge", `origin/${params.baseBranch}", "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }

    // Push the branch and capture the head SHA (never force-push).
    await runCommand("git", ["push", "origin", branch], {
      cwd: repoDir,
    });
    const headSha = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, captureStdout: true })
    ).trim();

    return {
      branch,
      pullRequestTitle:
        payload?.pullRequestTitle ?? params.issueTitle,
      pullRequestBody:
        payload?.pullRequestBody ?? `Closes #${params.issueNumber}`,
      headSha,
    };
  }

  async selfReview(params: SelfReviewParams): Promise<SelfReviewResult> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });

    // Capture the head SHA before Claude runs so we can detect whether any
    // commits were made.
    const headShaBeforeReview = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, captureStdout: true })
    ).trim();

    const prompt = buildSelfReviewPrompt(params);
    await this.runClaude(prompt, repoDir);

    // Push whatever Claude may have committed and report the new head SHA.
    const update = await this.pushAndReportHead(repoDir, params.headRefName);
    const madeChanges = update.headSha !== headShaBeforeReview;
    return { madeChanges, headSha: update.headSha };
  }

  async resolveMergeConflicts(
    params: ResolveMergeConflictsParams,
  ): Promise<AgentBranchUpdate> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });

    // Begin a rebase onto the (refreshed) base branch so Claude has
    // conflicts to resolve locally. We use a rebase so the resulting
    // branch is fast-forward mergeable on GitHub.
    await runCommand("git", ["fetch", "origin", params.baseRefName], { cwd: repoDir });
    try {
      await runCommand("git", ["rebase", `origin/${params.baseRefName}`], {
        cwd: repoDir,
        captureStdout: true,
        captureStderr: true,
      });
      // Rebase finished cleanly — no conflicts (race with the remote).
      // Merge latest from base branch using 'theirs' strategy before pushing.
      await runCommand("git", ["fetch", "origin", params.baseRefName], { cwd: repoDir });
      try {
        await runCommand("git", ["merge", `origin/${params.baseRefName}", "-X", "theirs", "--no-edit"], { cwd: repoDir });
      } catch (error) {
        throw new Error(`Failed to merge latest from base branch before push: ${error}`);
      }
      return this.pushAndReportHead(repoDir, params.headRefName, { forceWithLease: false });
    } catch (error) {
      const rebaseInProgress = await isRebaseInProgress(repoDir);
      if (!rebaseInProgress) {
        throw new Error(
          `Failed to rebase PR #${params.pullRequestNumber} onto origin/${params.baseRefName}: ${(error as Error).message}`,
        );
      }
      console.log(
        `[vibrator] Rebase onto origin/${params.baseRefName} produced conflicts for PR #${params.pullRequestNumber}; delegating conflict resolution to Claude.`,
      );
    }

    const prompt = buildResolveConflictsPrompt(params);
    await this.runClaude(prompt, repoDir);
    // Merge latest from base branch using 'theirs' strategy before pushing.
    await runCommand("git", ["fetch", "origin", params.baseRefName], { cwd: repoDir });
    try {
      await runCommand("git", ["merge", `origin/${params.baseRefName}", "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }
    return this.pushAndReportHead(repoDir, params.headRefName, { forceWithLease: false });
  }

  async addressFailingChecks(
    params: AddressFailingChecksParams,
  ): Promise<AgentBranchUpdate> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });
    const prompt = buildAddressFailingChecksPrompt(params);
    await this.runClaude(prompt, repoDir);
    return this.pushAndReportHead(repoDir, params.headRefName);
  }

  async generateFinalDescription(
    params: GenerateFinalDescriptionParams,
  ): Promise<string> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });
    const prompt = buildFinalDescriptionPrompt(params);
    const stdout = await this.runClaude(prompt, repoDir);
    return extractFinalDescription(stdout);
  }

  private async checkoutBaseBranch(params: {
    owner: string;
    repo: string;
    baseBranch: string;
    /** Unique identifier for this checkout (e.g. `issue-42`). Each concurrent
     *  implementation gets its own directory to avoid git ref-lock races. */
    identifier: string;
  }): Promise<string> {
    const repoDir = join(
      this.checkoutRootDir,
      `${params.owner}-${params.repo}`,
      params.identifier,
    );
    await mkdir(repoDir, { recursive: true });
    const gitDir = join(repoDir, ".git");
    if (!(await pathExists(gitDir))) {
      await runCommand(this.ghCommand, [
        "repo",
        "clone",
        `${params.owner}/${params.repo}`,
        repoDir,
      ]);
    }
    await runCommand(
      "git",
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: repoDir },
    );
    await runCommand("git", ["fetch", "origin", "--prune"], { cwd: repoDir });
    return repoDir;
  }

  private async checkoutPullRequest(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
  }): Promise<string> {
    const repoDir = join(
      this.checkoutRootDir,
      `${params.owner}-${params.repo}`,
      `pr-${params.pullRequestNumber}`,
    );

    await mkdir(repoDir, { recursive: true });

    const gitDir = join(repoDir, ".git");
    if (!(await pathExists(gitDir))) {
      await runCommand(this.ghCommand, [
        "repo",
        "clone",
        `${params.owner}/${params.repo}`,
        repoDir,
      ]);
    }

    await runCommand(
      "git",
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: repoDir },
    );
    await runCommand("git", ["fetch", "origin", "--prune"], { cwd: repoDir });

    // Abort any rebase or merge left in progress by a previous iteration so
    // that `gh pr checkout --force` can proceed cleanly.
    if (
      (await pathExists(join(repoDir, ".git", "rebase-merge"))) ||
      (await pathExists(join(repoDir, ".git", "rebase-apply")))
    ) {
      await runCommand("git", ["rebase", "--abort"], { cwd: repoDir });
    }
    if (await pathExists(join(repoDir, ".git", "MERGE_HEAD"))) {
      await runCommand("git", ["merge", "--abort"], { cwd: repoDir });
    }

    await runCommand(
      this.ghCommand,
      ["pr", "checkout", String(params.pullRequestNumber), "--force"],
      { cwd: repoDir },
    );

    return repoDir;
  }

  private async pushAndReportHead(
    repoDir: string,
    branch: string,
    options: { forceWithLease?: boolean } = {},
  ): Promise<AgentBranchUpdate> {
    // Always merge latest from base branch using 'theirs' strategy before pushing.
    // Try to infer the base branch from the remote-tracking branch if possible.
    let baseBranch = 'main';
    try {
      const branchInfo = await runCommand("git", ["for-each-ref", `refs/heads/${branch}`, "--format=%(upstream:short)"], { cwd: repoDir, captureStdout: true });
      if (branchInfo && branchInfo.includes('/')) {
        baseBranch = branchInfo.split('/')[1].trim();
      }
    } catch {}
    await runCommand("git", ["fetch", "origin", baseBranch], { cwd: repoDir });
    try {
      await runCommand("git", ["merge", `origin/${baseBranch}", "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }
    const args = ["push", "origin", `HEAD:${branch}`];
    await runCommand("git", args, { cwd: repoDir });
    const headSha = (
      await runCommand("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        captureStdout: true,
      })
    ).trim();
    return { headSha };
  }

  private async runClaude(prompt: string, cwd: string): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Use the local Claude Code subscription, not the Anthropic Platform API.
    // Removing ANTHROPIC_API_KEY forces the claude CLI to authenticate via
    // the subscription credentials in ~/.claude/.credentials.json.
    delete env.ANTHROPIC_API_KEY;
    // Avoid the `gh` CLI inside Claude's tool use picking up vibrator's
    // own GitHub token (which may have different permissions than the
    // user's `gh auth` setup).
    delete env.GH_TOKEN;
    const modelArgs = this.claudeModel ? ["--model", this.claudeModel] : [];

    const startTime = Date.now();
    const isTTY = process.stdout.isTTY === true;
    let lastPreview = "";

    // Short display name for the model: strip the leading "claude-" prefix so
    // "claude-sonnet-4-5" becomes "sonnet-4-5" and bare names are shown as-is.
    const modelDisplay = (this.claudeModel ?? "claude").replace(/^claude-/i, "");

    const formatElapsed = (): string => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const writeStatus = (): void => {
      const preview = lastPreview ? ` · ${lastPreview}` : "";
      const line = `  Claude [${modelDisplay}] [${formatElapsed()}]${preview}`;
      const width = (process.stdout.columns ?? 120) - 1;
      process.stdout.write(`\r${line.slice(0, width).padEnd(width)}`);
    };

    if (isTTY) {
      process.stdout.write(`  Claude [${modelDisplay}] [0s]`);
    } else {
      console.log(`Sending request to Claude CLI [${modelDisplay}] (waiting for response)…`);
    }

    const ticker = isTTY ? setInterval(writeStatus, 500) : undefined;

    const extractPreview = (chunk: string): void => {
      // Pick the last short, non-empty line from the chunk as a live preview.
      // Skip blank lines and very long code/diff lines to keep the display clean.
      const lines = chunk.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i]!.trim();
        if (trimmed.length >= 4 && trimmed.length <= 80) {
          lastPreview = trimmed;
          break;
        }
      }
    };

    const tryBuildQuotaMessage = (message: string): { text: string; blockedUntilMs: number } | undefined => {
      if (!isClaudeUsageLimitMessage(message)) {
        return undefined;
      }

      const blockedUntilMs =
        parseUsageResetTimeMs(message) ?? Date.now() + DEFAULT_QUOTA_BACKOFF_MS;

      const resetLine = message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /reset|out of extra usage/i.test(line));

      const text =
        "Claude CLI usage limit reached" +
        (resetLine ? ` (${resetLine}).` : ".") +
        ` Skipping Claude actions until approximately ${formatLocalTime(blockedUntilMs)} local time.`;

      return { text, blockedUntilMs };
    };

    if (claudeQuotaBlockedUntilMs !== undefined && Date.now() < claudeQuotaBlockedUntilMs) {
      throw new Error(
        `Claude CLI usage limit reached. Skipping Claude actions until approximately ${formatLocalTime(claudeQuotaBlockedUntilMs)} local time.`,
      );
    }

    try {
      const result = await runCommand(
        this.claudeCommand,
        [
          "--print",
          "--permission-mode",
          "bypassPermissions",
          ...modelArgs,
          prompt,
        ],
        {
          cwd,
          captureStdout: true,
          captureStderr: true,
          env,
          timeoutMs: this.claudeTimeoutMs,
          // Use stderr for the live preview: the Claude CLI writes its
          // streaming progress (tool calls, thinking, etc.) to stderr even
          // when stdout is piped, so we get real-time updates here.
          ...(isTTY && { onStderrChunk: extractPreview }),
        },
      );

      if (isTTY) {
        clearInterval(ticker);
        const done = `  Claude [${modelDisplay}] done [${formatElapsed()}]`;
        const width = (process.stdout.columns ?? 120) - 1;
        process.stdout.write(`\r${done.padEnd(width)}\n`);
      }
      return result;
    } catch (error) {
      if (isTTY) {
        clearInterval(ticker);
        process.stdout.write("\n");
      }
      const message = error instanceof Error ? error.message : String(error);
      const quotaMessage = tryBuildQuotaMessage(message);
      if (quotaMessage) {
        claudeQuotaBlockedUntilMs = quotaMessage.blockedUntilMs;
        throw new Error(quotaMessage.text, { cause: error });
      }
      throw error;
    }
  }
}

export function createClaudeAgentClient(
  options: ClaudeAgentClientOptions = {},
): ClaudeAgentClient {
  return new DefaultClaudeAgentClient(options);
}
