import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalEventEmitter } from "./event-emitter.js";
import type { ClaudeAccountManager } from "./claude-account-manager.js";



// ─── Thinking-preview extractor ─────────────────────────────────────────────

/**
 * Extracts a short readable preview from a raw verbose chunk emitted by the
 * Claude CLI stderr stream. Strips ANSI codes, picks the last non-empty line,
 * and truncates to a display-friendly length.
 */
export function extractThinkingPreview(chunk: string): string {
  const plain = chunk
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // strip ANSI escape sequences
    .replace(/\r/g, "");
  const lines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines.at(-1) ?? "";
  return last.length > 120 ? `${last.slice(0, 117)}…` : last;
}

// ─── Multi-run terminal status board ────────────────────────────────────────

interface StatusSlot {
  label: string;
  startTime: number;
  thinking: string;
}

/**
 * Manages N updating status lines at the bottom of the terminal (one per
 * concurrent Claude run). On a TTY it uses ANSI cursor movement to redraw the
 * lines in place every 500 ms; on non-TTY output it falls back to plain log
 * lines so CI and piped consumers still see start/done messages.
 */
class StatusBoard {
  private readonly slots = new Map<number, StatusSlot>();
  private nextId = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  private get tty(): boolean {
    return process.stderr.isTTY === true;
  }

  allocate(label: string): number {
    const id = this.nextId++;
    this.slots.set(id, { label, startTime: Date.now(), thinking: "" });
    if (this.tty) {
      // Reserve a blank terminal line for this slot.
      process.stderr.write("\n");
      if (!this.timer) {
        this.timer = setInterval(() => { this.redraw(); }, 500);
      }
    } else {
      process.stderr.write(`Claude [${label}] starting…\n`);
    }
    return id;
  }

  update(id: number, thinking: string): void {
    const slot = this.slots.get(id);
    if (slot && thinking) {
      slot.thinking = thinking;
    }
  }

  free(id: number, doneMessage: string): void {
    if (!this.slots.has(id)) return;
    if (this.tty) {
      const count = this.slots.size;
      if (count === 1) {
        // Last active slot: replace its line in-place and stop.
        this.redrawWithReplacement(id, doneMessage);
      } else {
        // Other slots still running: write done message at top of board and
        // compact remaining live slots below it. This keeps the cursor anchor
        // at `count` lines below the board top so subsequent redraws (which
        // move up `count-1`) land correctly on the first remaining live slot.
        process.stderr.write(`\x1b[${count}A`);
        process.stderr.write(`\r\x1b[2K${doneMessage}\n`);
        for (const [sid, slot] of this.slots) {
          if (sid !== id) {
            process.stderr.write(`\r\x1b[2K${this.renderSlot(slot)}\n`);
          }
        }
      }
    } else {
      process.stderr.write(`${doneMessage}\n`);
    }
    this.slots.delete(id);
    if (this.slots.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private fmtElapsed(startTime: number): string {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  private renderSlot(slot: StatusSlot): string {
    const elapsed = this.fmtElapsed(slot.startTime);
    const tail = slot.thinking ? ` ▌ ${slot.thinking.slice(0, 80)}` : "";
    return `[${elapsed}] Claude [${slot.label}]${tail}`;
  }

  private redraw(): void {
    const count = this.slots.size;
    if (count === 0) return;
    process.stderr.write(`\x1b[${count}A`); // cursor up N lines
    for (const slot of this.slots.values()) {
      process.stderr.write(`\r\x1b[2K${this.renderSlot(slot)}\n`);
    }
  }

  private redrawWithReplacement(targetId: number, replacement: string): void {
    const count = this.slots.size;
    if (count === 0) return;
    process.stderr.write(`\x1b[${count}A`);
    for (const [id, slot] of this.slots) {
      const line = id === targetId ? replacement : this.renderSlot(slot);
      process.stderr.write(`\r\x1b[2K${line}\n`);
    }
  }
}

const statusBoard = new StatusBoard();

// ─────────────────────────────────────────────────────────────────────────────

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

export interface UserComment {
  author: string;
  body: string;
  createdAt: string;
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
  /** Human comments on the PR (excluding bot comments) that should steer the review. */
  userComments?: ReadonlyArray<UserComment>;
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
  /** Human comments on the PR (excluding bot comments) that should steer conflict resolution. */
  userComments?: ReadonlyArray<UserComment>;
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
  /** Human comments on the PR (excluding bot comments) that should steer the fix. */
  userComments?: ReadonlyArray<UserComment>;
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
  /** Model used specifically for commit message generation. Defaults to CLAUDE_COMMIT_MODEL env, then claude-haiku-4-5-20251001. */
  claudeCommitModel?: string;
  /**
   * Maximum milliseconds the Claude CLI is allowed to run before being killed.
   * Defaults to CLAUDE_TIMEOUT_MS env var, or 30 minutes if unset.
   */
  claudeTimeoutMs?: number;
  /**
   * Optional multi-account manager for rotating between Claude Code accounts
   * when rate limits are reached.  When omitted, the client uses a single
   * implicit account (the default ~/.claude credentials).
   */
  accountManager?: ClaudeAccountManager;
  /** Zero-based index of the engine loop that owns this client instance. Used to route live thinking events to the correct dashboard cylinder. */
  engineIndex?: number;
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

export function formatUserCommentsSection(userComments: ReadonlyArray<UserComment> | undefined): string[] {
  if (!userComments || userComments.length === 0) return [];
  const formatted = userComments.map((c) => `**${c.author}** (${c.createdAt}):\n${c.body}`);
  return [
    "",
    "Human comments on this PR (take these into account when doing your work):",
    "---",
    ...formatted,
    "---",
  ];
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
    ...formatUserCommentsSection(params.userComments),
    "",
    "Instructions:",
    `1. Read the full diff (\`git diff origin/${params.baseRefName}..HEAD\`) and the surrounding code carefully.`,
    `2. Evaluate the changes strictly against the requirements in issue #${params.issueNumber !== undefined ? params.issueNumber : "(above)"}. Only flag problems that are relevant to what this issue asked for: bugs, missing requirements, broken or missing tests, security issues, or significant design problems within the scope of this change. Do not comment on pre-existing code or unrelated areas.`,
    "3. If there are human comments on the PR (shown above), address any requests or concerns raised in them.",
    "4. If you find any problems, fix them directly by editing the files. Commit every change with a clear, descriptive commit message that explains what was changed and why.",
    "5. If you find nothing that needs to change, make no commits and output only a brief 'LGTM' message.",
    "",
    "Be honest and thorough — this is your own code and the goal is to ship high-quality work that fully satisfies the issue.",
  ].join("\n");
}

function buildResolveConflictsPrompt(params: ResolveMergeConflictsParams): string {
  return [
    `You are resolving merge conflicts on pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `The current branch \`${params.headRefName}\` has been rebased onto \`origin/${params.baseRefName}\` and is in a conflicted state (or about to be — run \`git status\` first).`,
    ...formatUserCommentsSection(params.userComments),
    "",
    "Instructions:",
    "1. Inspect the conflicts (`git status`, `git diff --check`).",
    "2. Resolve each conflict by editing the files so the resulting code is correct and integrates both sides of the merge meaningfully.",
    "3. If there are human comments on the PR (shown above), keep their requests in mind when resolving conflicts.",
    "4. `git add` the resolved files and commit (either continue the rebase with `git rebase --continue` or, if a non-rebase merge is in progress, `git commit`).",
    "5. Do not push — the orchestrator handles pushing.",
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
    ...formatUserCommentsSection(params.userComments),
    "",
    "Instructions:",
    "1. Diagnose the failure(s) by reading the code referenced in the logs.",
    "2. Fix the underlying problem. Re-run the tests/linters locally if available.",
    "3. If there are human comments on the PR (shown above), address any requests or concerns raised in them.",
    "4. Commit every change with a descriptive commit message.",
    "5. Do not push — the orchestrator handles pushing.",
  ].join("\n");
}

function buildPushConflictResolutionPrompt(branch: string): string {
  return [
    `A git merge conflict occurred while preparing to push branch \`${branch}\` to origin.`,
    "",
    "The repository is currently in an in-progress merge state.",
    "",
    "Instructions:",
    "1. Run `git status` and inspect all conflicted files.",
    "2. Resolve every conflict carefully, preserving both local and remote intent where appropriate.",
    "3. Stage resolved files with `git add`.",
    "4. Complete the merge by creating a commit (`git commit`) with a clear message.",
    "5. Do not run `git push` yourself; stop after the merge commit succeeds.",
    "",
    "If a safe resolution is not possible, stop and explain why.",
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
let claudeTermsAcceptanceRequired = false;

export function getClaudeQuotaBlockedUntilMs(): number | undefined {
  return claudeQuotaBlockedUntilMs;
}

export function isClaudeUsageLimitMessage(message: string): boolean {
  return /out of extra usage|out of usage|hit your limit|rate limit|quota|usage limit/i.test(
    message,
  );
}

export function isClaudeTermsAcceptanceMessage(message: string): boolean {
  return /consumer terms and privacy policy|accept them in claude\.ai|updated our consumer terms/i.test(
    message,
  );
}

export function isNonFastForwardPushError(message: string): boolean {
  return /non-fast-forward|failed to push some refs|tip of your current branch is behind/i.test(
    message,
  );
}

export function parseOriginHeadBranch(symbolicRef: string): string | undefined {
  const trimmed = symbolicRef.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("origin/")) {
    const branch = trimmed.slice("origin/".length).trim();
    return branch.length > 0 ? branch : undefined;
  }
  if (trimmed.startsWith("refs/remotes/origin/")) {
    const branch = trimmed.slice("refs/remotes/origin/".length).trim();
    return branch.length > 0 ? branch : undefined;
  }
  return undefined;
}

async function resolveBaseBranch(repoDir: string, preferredBaseBranch?: string): Promise<string> {
  const preferred = preferredBaseBranch?.trim();
  if (preferred) {
    return preferred;
  }

  try {
    const originHead = (
      await runCommand(
        "git",
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        { cwd: repoDir, captureStdout: true },
      )
    ).trim();
    return parseOriginHeadBranch(originHead) ?? "main";
  } catch {
    return "main";
  }
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

function buildPushRecoveryBackupBranchName(branch: string): string {
  const sanitizedBranch = branch
    .replace(/[^a-zA-Z0-9/_-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `vibrator/recovery-${sanitizedBranch || "branch"}-${Date.now()}`;
}

export const DEFAULT_COMMIT_MODEL = "claude-haiku-4-5-20251001";

class DefaultClaudeAgentClient implements ClaudeAgentClient {
  private readonly checkoutRootDir: string;
  private readonly claudeCommand: string;
  private readonly ghCommand: string;
  private readonly claudeModel: string | undefined;
  private readonly claudeCommitModel: string;
  private readonly claudeTimeoutMs: number;
  private readonly accountManager: ClaudeAccountManager | undefined;
  private readonly engineIndex: number | undefined;

  constructor(options: ClaudeAgentClientOptions = {}) {
    this.checkoutRootDir = options.checkoutRootDir ?? defaultCheckoutRootDir();
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.ghCommand = options.ghCommand ?? "gh";
    this.claudeModel = options.claudeModel ?? process.env.CLAUDE_MODEL;
    this.claudeCommitModel =
      options.claudeCommitModel ?? process.env.CLAUDE_COMMIT_MODEL ?? DEFAULT_COMMIT_MODEL;
    const envTimeout = process.env.CLAUDE_TIMEOUT_MS;
    this.claudeTimeoutMs =
      options.claudeTimeoutMs ??
      (envTimeout !== undefined ? Number.parseInt(envTimeout, 10) : DEFAULT_CLAUDE_TIMEOUT_MS);
    this.accountManager = options.accountManager;
    this.engineIndex = options.engineIndex;
  }

  async implementIssue(params: ImplementIssueParams): Promise<ImplementIssueResult> {
    const branch = `vibrator/issue-${params.issueNumber}-${slugifyIssueTitle(params.issueTitle)}`;
    const repoDir = await this.checkoutBaseBranch({
      owner: params.owner,
      repo: params.repo,
      baseBranch: params.baseBranch,
      identifier: `issue-${params.issueNumber}`,
    });

    const branchAlreadyExistsRemotely = await this.remoteBranchExists(repoDir, branch);
    const branchStartPoint = branchAlreadyExistsRemotely
      ? `origin/${branch}`
      : `origin/${params.baseBranch}`;

    // Create or reset the feature branch from an up-to-date starting point.
    await runCommand("git", ["checkout", "-B", branch, branchStartPoint], {
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
          await runCommand("git", ["merge", `origin/${params.baseBranch}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }

    // Push the branch and capture the head SHA (never force-push).
    await this.pushWithRemoteBranchMergeRetry(repoDir, ["push", "origin", branch], branch);
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

    // Determine whether Claude actually committed review fixes before the
    // orchestrator merges the latest base branch during push.
    const headShaAfterReview = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, captureStdout: true })
    ).trim();
    const madeChanges = headShaAfterReview !== headShaBeforeReview;

    // Push whatever Claude may have committed and report the new head SHA.
    const update = await this.pushAndReportHead(repoDir, params.headRefName, {
      baseBranch: params.baseRefName,
    });
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
              await runCommand("git", ["merge", `origin/${params.baseRefName}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
      } catch (error) {
        throw new Error(`Failed to merge latest from base branch before push: ${error}`);
      }
      return this.pushAndReportHead(repoDir, params.headRefName, {
        forceWithLease: false,
        baseBranch: params.baseRefName,
      });
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
            await runCommand("git", ["merge", `origin/${params.baseRefName}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }
    return this.pushAndReportHead(repoDir, params.headRefName, {
      forceWithLease: false,
      baseBranch: params.baseRefName,
    });
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
    return this.pushAndReportHead(repoDir, params.headRefName, {
      baseBranch: params.baseRefName,
    });
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
    const stdout = await this.runClaude(prompt, repoDir, this.claudeCommitModel);
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
    options: { forceWithLease?: boolean; baseBranch?: string } = {},
  ): Promise<AgentBranchUpdate> {
    // Always merge latest from the PR base branch before pushing.
    const baseBranch = await resolveBaseBranch(repoDir, options.baseBranch);
    await runCommand("git", ["fetch", "origin", baseBranch], { cwd: repoDir });
    try {
      await runCommand("git", ["merge", `origin/${baseBranch}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }
    const args = ["push", "origin", `HEAD:${branch}`];
    await this.pushWithRemoteBranchMergeRetry(repoDir, args, branch);
    const headSha = (
      await runCommand("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        captureStdout: true,
      })
    ).trim();
    return { headSha };
  }

  private async remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
    try {
      await runCommand(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
        { cwd: repoDir },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async pushWithRemoteBranchMergeRetry(
    repoDir: string,
    pushArgs: readonly string[],
    branch: string,
  ): Promise<void> {
    try {
      await runCommand("git", pushArgs, { cwd: repoDir, captureStderr: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNonFastForwardPushError(message)) {
        throw error;
      }
    }

    const backupBranch = buildPushRecoveryBackupBranchName(branch);
    await runCommand("git", ["branch", backupBranch, "HEAD"], { cwd: repoDir });

    console.warn(
      `[vibrator] Push for ${branch} was rejected as non-fast-forward. Preserved recovery point at ${backupBranch}; integrating origin/${branch} before retrying.`,
    );

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      await runCommand("git", ["fetch", "origin", branch], { cwd: repoDir });

      try {
        await runCommand("git", ["merge", `origin/${branch}`, "--no-edit"], {
          cwd: repoDir,
          captureStderr: true,
        });
      } catch (error) {
        const mergeInProgress = await pathExists(join(repoDir, ".git", "MERGE_HEAD"));
        if (!mergeInProgress) {
          throw new Error(
            `Push rejected as non-fast-forward and merge of origin/${branch} failed before retry: ${error}`,
          );
        }

        console.warn(
          `[vibrator] Merge conflict while integrating origin/${branch} before push retry (${attempt}/${maxRetries}); delegating resolution to Claude.`,
        );
        await this.runClaude(buildPushConflictResolutionPrompt(branch), repoDir);

        const stillMerging = await pathExists(join(repoDir, ".git", "MERGE_HEAD"));
        if (stillMerging) {
          throw new Error(
            `Claude did not complete merge-conflict resolution for ${branch}; merge is still in progress. Recovery branch: ${backupBranch}`,
          );
        }
      }

      try {
        await runCommand("git", pushArgs, { cwd: repoDir, captureStderr: true });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isNonFastForwardPushError(message) || attempt === maxRetries) {
          throw new Error(
            `Failed to push ${branch} after ${attempt} non-fast-forward recovery attempt(s). Recovery branch: ${backupBranch}. ${message}`,
          );
        }
      }
    }
  }

  private async runClaude(prompt: string, cwd: string, modelOverride?: string): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Use the local Claude Code subscription, not the Anthropic Platform API.
    // Removing ANTHROPIC_API_KEY forces the claude CLI to authenticate via
    // the subscription credentials in ~/.claude/.credentials.json (or the
    // directory pointed to by CLAUDE_HOME when multi-account mode is active).
    delete env.ANTHROPIC_API_KEY;
    // Avoid the `gh` CLI inside Claude's tool use picking up vibrator's
    // own GitHub token (which may have different permissions than the
    // user's `gh auth` setup).
    delete env.GH_TOKEN;
    const effectiveModel = modelOverride ?? this.claudeModel;
    const modelArgs = effectiveModel ? ["--model", effectiveModel] : [];

    const startTime = Date.now();

    // Short display name for the model: strip the leading "claude-" prefix so
    // "claude-sonnet-4-5" becomes "sonnet-4-5" and bare names are shown as-is.
    const modelDisplay = (effectiveModel ?? "claude").replace(/^claude-/i, "");

    const formatElapsed = (): string => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
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

    // ── Multi-account mode ────────────────────────────────────────────────
    // When an account manager is configured, pick the next available account
    // and point CLAUDE_HOME at its config directory so the Claude CLI loads
    // the correct subscription credentials.
    let activeConfigDir: string | undefined;
    if (this.accountManager) {
      activeConfigDir = this.accountManager.acquireAccount();
      if (activeConfigDir === undefined) {
        const nextMs = this.accountManager.earliestAvailableMs();
        const when = nextMs !== undefined ? ` until approximately ${formatLocalTime(nextMs)} local time` : "";
        throw new Error(
          `All Claude accounts are rate-limited${when}. Skipping Claude actions until an account becomes available.`,
        );
      }
      // CLAUDE_HOME overrides the default ~/.claude config directory so the
      // Claude CLI picks up the credentials for this specific account.
      env.CLAUDE_HOME = activeConfigDir;
    } else {
      // ── Single-account mode (legacy) ──────────────────────────────────
      if (claudeQuotaBlockedUntilMs !== undefined && Date.now() < claudeQuotaBlockedUntilMs) {
        throw new Error(
          `Claude CLI usage limit reached. Skipping Claude actions until approximately ${formatLocalTime(claudeQuotaBlockedUntilMs)} local time.`,
        );
      }

      if (claudeTermsAcceptanceRequired) {
        throw new Error(
          "Claude CLI account action required. Accept the updated Consumer Terms and Privacy Policy at claude.ai using the account shown in `claude /status`, then restart vibrator.",
        );
      }
    }

    const accountSuffix = activeConfigDir ? ` [${activeConfigDir}]` : "";
    const slotId = statusBoard.allocate(`${modelDisplay}${accountSuffix}`);

    try {
      const result = await runCommand(
        this.claudeCommand,
        [
          "--print",
          "--verbose",
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
          onStderrChunk: (chunk: string) => {
            const preview = extractThinkingPreview(chunk);
            if (preview) {
              statusBoard.update(slotId, preview);
              globalEventEmitter.emit("claude-thinking", {
                model: modelDisplay,
                excerpt: preview,
                ...(this.engineIndex !== undefined ? { engineIndex: this.engineIndex } : {}),
              });
            }
          },
        },
      );

      statusBoard.free(slotId, `Claude [${modelDisplay}] done [${formatElapsed()}]`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const quotaMessage = tryBuildQuotaMessage(message);
      statusBoard.free(
        slotId,
        quotaMessage
          ? `Claude [${modelDisplay}] quota limit [${formatElapsed()}]`
          : `Claude [${modelDisplay}] error [${formatElapsed()}]`,
      );
      if (quotaMessage) {
        if (this.accountManager && activeConfigDir) {
          // In multi-account mode, record the rate limit against this specific
          // account so subsequent invocations can rotate to another one.
          await this.accountManager.markRateLimited(activeConfigDir, quotaMessage.blockedUntilMs);
          const remaining = this.accountManager.acquireAccount();
          const earliestMs = remaining === undefined ? this.accountManager.earliestAvailableMs() : undefined;
          const suffix = remaining !== undefined
            ? ` Rotating to next available account.`
            : ` No more accounts available; waiting until ${formatLocalTime(earliestMs ?? quotaMessage.blockedUntilMs)}.`;
          throw new Error(quotaMessage.text + suffix, { cause: error });
        } else {
          claudeQuotaBlockedUntilMs = quotaMessage.blockedUntilMs;
          throw new Error(quotaMessage.text, { cause: error });
        }
      }
      if (isClaudeTermsAcceptanceMessage(message)) {
        claudeTermsAcceptanceRequired = true;
        throw new Error(
          "Claude CLI account action required. Accept the updated Consumer Terms and Privacy Policy at claude.ai using the account shown in `claude /status`, then restart vibrator.",
          { cause: error },
        );
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

export type { ClaudeAgentClientOptions };
