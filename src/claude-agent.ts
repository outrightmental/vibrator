import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PullRequestInlineComment } from "./types.js";

/**
 * Local Claude coding-agent client. The default implementation shells out
 * to the `claude` CLI (Claude Code) inside a fresh checkout of the
 * repository / pull request branch so the CLI can read, modify, commit,
 * and (where applicable) push code.
 *
 * Every coding-agent operation runs synchronously: `vibrator` waits for
 * Claude to finish, then continues the loop. There is no remote
 * "coding agent assignee" to wait for, no acknowledgment timeout, and
 * no out-of-band PR creation — this client opens the PR itself when
 * implementing an issue.
 */
export interface ClaudeAgentClient {
  implementIssue(params: ImplementIssueParams): Promise<ImplementIssueResult>;
  addressReviewComments(
    params: AddressReviewCommentsParams,
  ): Promise<AgentBranchUpdate>;
  resolveMergeConflicts(
    params: ResolveMergeConflictsParams,
  ): Promise<AgentBranchUpdate>;
  addressFailingChecks(
    params: AddressFailingChecksParams,
  ): Promise<AgentBranchUpdate>;
  reviewPullRequest(params: ReviewPullRequestParams): Promise<ReviewPullRequestResult>;
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

export interface AddressReviewCommentsParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestBody: string;
  /** Branch the PR is opened from. */
  headRefName: string;
  /** Branch the PR targets. */
  baseRefName: string;
  /** Pre-fetched unresolved review comments to address. */
  reviewComments: ReadonlyArray<{
    path: string;
    line: number | null;
    body: string;
    author: string;
  }>;
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

export interface ReviewPullRequestParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestBody: string;
  headRefName: string;
  baseRefName: string;
}

export interface ReviewPullRequestResult {
  /** Free-text top-level review body. */
  summary: string;
  /** Inline comments — empty when the reviewer was satisfied. */
  inlineComments: PullRequestInlineComment[];
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
 * Sentinel markers wrapping the JSON review payload (summary + inline
 * comments) the Claude reviewer must emit.
 */
export const REVIEW_PAYLOAD_START_MARKER = "<<<VIBRATOR_REVIEW_START>>>";
export const REVIEW_PAYLOAD_END_MARKER = "<<<VIBRATOR_REVIEW_END>>>";

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
  /** Anthropic API key. When omitted, falls back to ANTHROPIC_API_KEY env. */
  anthropicApiKey?: string;
  /** Model to pass to the claude CLI via --model. When omitted, falls back to CLAUDE_MODEL env. */
  claudeModel?: string;
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

interface RunCommandOptions {
  cwd?: string;
  input?: string;
  captureStdout?: boolean;
  env?: NodeJS.ProcessEnv;
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
        "inherit",
      ],
    });

    const stdoutChunks: Buffer[] = [];
    if (options.captureStdout && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Command \`${command} ${args.join(" ")}\` exited with non-zero status ${code ?? "unknown"}.`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf8"));
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

export function extractReviewPayload(
  rawOutput: string,
): ReviewPullRequestResult {
  const inner = extractBetweenMarkers(
    rawOutput,
    REVIEW_PAYLOAD_START_MARKER,
    REVIEW_PAYLOAD_END_MARKER,
  );
  if (!inner) {
    // No marker found — treat the whole output as a free-text summary
    // with zero inline comments (i.e. clean review).
    return { summary: rawOutput.trim(), inlineComments: [] };
  }
  const parsed = parseReviewJson(inner);
  return parsed;
}

function parseReviewJson(payload: string): ReviewPullRequestResult {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return { summary: payload, inlineComments: [] };
  }
  if (typeof data !== "object" || data === null) {
    return { summary: payload, inlineComments: [] };
  }
  const obj = data as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const rawComments = Array.isArray(obj.comments) ? obj.comments : [];
  const inlineComments: PullRequestInlineComment[] = [];
  for (const entry of rawComments) {
    if (typeof entry !== "object" || entry === null) continue;
    const comment = entry as Record<string, unknown>;
    if (
      typeof comment.path === "string" &&
      typeof comment.line === "number" &&
      Number.isFinite(comment.line) &&
      typeof comment.body === "string" &&
      comment.body.trim().length > 0
    ) {
      inlineComments.push({
        path: comment.path,
        line: Math.floor(comment.line),
        body: comment.body,
      });
    }
  }
  return { summary, inlineComments };
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

function buildAddressReviewCommentsPrompt(params: AddressReviewCommentsParams): string {
  const commentList =
    params.reviewComments.length === 0
      ? "(no unresolved review comments were provided — re-inspect the PR yourself with `gh pr view`)"
      : params.reviewComments
          .map(
            (c, i) =>
              `${i + 1}. ${c.path}${c.line !== null ? `:${c.line}` : ""} — @${c.author}:\n${c.body}`,
          )
          .join("\n\n");

  return [
    `You are addressing reviewer comments on pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `PR title: ${params.pullRequestTitle}`,
    `Branch: \`${params.headRefName}\` (targets \`${params.baseRefName}\`).`,
    "",
    "Unresolved review comments to address:",
    "---",
    commentList,
    "---",
    "",
    "Instructions:",
    "1. For each unresolved review comment, either make the change the reviewer is requesting OR, if the existing code is already correct, leave a reply explaining why (use `gh pr comment`).",
    "2. Commit every code change to the current branch with descriptive commit messages.",
    "3. Be conservative: only modify what the reviewer pointed out plus anything strictly required to make the tests pass.",
    "",
    "After all commits are made, summarize what you changed in plain text. The orchestrator will push the branch automatically.",
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

function buildReviewPrompt(params: ReviewPullRequestParams): string {
  return [
    `You are reviewing pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `PR title: ${params.pullRequestTitle}`,
    `Branch: \`${params.headRefName}\` (targets \`${params.baseRefName}\`).`,
    "",
    "Current PR description:",
    "---",
    params.pullRequestBody || "(empty)",
    "---",
    "",
    "Instructions:",
    "1. Read the diff (`git diff origin/" + params.baseRefName + "..HEAD`) and the surrounding code.",
    "2. Identify substantive problems: bugs, regressions, missing tests, security issues, design problems. Style nits are out of scope.",
    "3. Do not modify any files. Do not commit. Only produce a review.",
    "4. Emit a JSON object summarizing the review between the exact sentinel markers below.",
    "",
    `${REVIEW_PAYLOAD_START_MARKER}`,
    `{`,
    `  "summary": "<short Markdown summary of the review — what looked good, what needs work, or 'LGTM' when nothing needs to change>",`,
    `  "comments": [`,
    `    { "path": "<file path>", "line": <1-based line number on the PR's right side>, "body": "<what needs to change and why>" }`,
    `  ]`,
    `}`,
    `${REVIEW_PAYLOAD_END_MARKER}`,
    "",
    "Output requirements:",
    "- The JSON object must appear exactly once between the sentinels and must be valid JSON (no trailing commas, no code fences).",
    `- An empty \`comments\` array means the PR is approved as-is — use this when the change is good to merge.`,
    "- Only flag genuine issues. Do not add comments just to seem thorough.",
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

class DefaultClaudeAgentClient implements ClaudeAgentClient {
  private readonly checkoutRootDir: string;
  private readonly claudeCommand: string;
  private readonly ghCommand: string;
  private readonly anthropicApiKey: string | undefined;
  private readonly claudeModel: string | undefined;

  constructor(options: ClaudeAgentClientOptions = {}) {
    this.checkoutRootDir = options.checkoutRootDir ?? defaultCheckoutRootDir();
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.ghCommand = options.ghCommand ?? "gh";
    this.anthropicApiKey = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    this.claudeModel = options.claudeModel ?? process.env.CLAUDE_MODEL;
  }

  async implementIssue(params: ImplementIssueParams): Promise<ImplementIssueResult> {
    const branch = `vibrator/issue-${params.issueNumber}-${slugifyIssueTitle(params.issueTitle)}`;
    const repoDir = await this.checkoutBaseBranch({
      owner: params.owner,
      repo: params.repo,
      baseBranch: params.baseBranch,
    });

    // Create or reset the feature branch from the up-to-date base.
    await runCommand("git", ["checkout", "-B", branch, `origin/${params.baseBranch}`], {
      cwd: repoDir,
    });

    const prompt = buildImplementationPrompt(params, branch);
    const stdout = await this.runClaude(prompt, repoDir);
    const payload = extractImplementationPayload(stdout);

    // Push the branch and capture the head SHA.
    await runCommand("git", ["push", "--force-with-lease", "origin", branch], {
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

  async addressReviewComments(
    params: AddressReviewCommentsParams,
  ): Promise<AgentBranchUpdate> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });
    const prompt = buildAddressReviewCommentsPrompt(params);
    await this.runClaude(prompt, repoDir);
    return this.pushAndReportHead(repoDir, params.headRefName);
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
      await runCommand("git", ["rebase", `origin/${params.baseRefName}`], { cwd: repoDir });
      // Rebase finished cleanly — no conflicts (race with the remote).
      return this.pushAndReportHead(repoDir, params.headRefName, { forceWithLease: true });
    } catch {
      // Conflicts — let Claude resolve them.
    }

    const prompt = buildResolveConflictsPrompt(params);
    await this.runClaude(prompt, repoDir);
    return this.pushAndReportHead(repoDir, params.headRefName, { forceWithLease: true });
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

  async reviewPullRequest(
    params: ReviewPullRequestParams,
  ): Promise<ReviewPullRequestResult> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });
    const prompt = buildReviewPrompt(params);
    const stdout = await this.runClaude(prompt, repoDir);
    return extractReviewPayload(stdout);
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
  }): Promise<string> {
    const repoDir = join(
      this.checkoutRootDir,
      `${params.owner}-${params.repo}`,
      "base",
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
    const args = ["push"];
    if (options.forceWithLease) args.push("--force-with-lease");
    args.push("origin", `HEAD:${branch}`);
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
    if (!this.anthropicApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Provide it via the environment or the ClaudeAgentClient constructor.",
      );
    }
    console.log("Sending request to Claude CLI (waiting for response)…");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: this.anthropicApiKey,
    };
    // Avoid the `gh` CLI inside Claude's tool use picking up vibrator's
    // own GitHub token (which may have different permissions than the
    // user's `gh auth` setup).
    delete env.GH_TOKEN;
    const modelArgs = this.claudeModel ? ["--model", this.claudeModel] : [];
    return runCommand(
      this.claudeCommand,
      [
        "--print",
        "--permission-mode",
        "acceptEdits",
        ...modelArgs,
        prompt,
      ],
      {
        cwd,
        captureStdout: true,
        env,
      },
    );
  }
}

export function createClaudeAgentClient(
  options: ClaudeAgentClientOptions = {},
): ClaudeAgentClient {
  return new DefaultClaudeAgentClient(options);
}
