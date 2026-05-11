import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Parameters required to generate a final pull-request description by running
 * the local `copilot` CLI inside a checkout of the PR branch.
 */
export interface GenerateFinalDescriptionParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestBody: string;
  headRefName: string;
  closingIssueNumbers: readonly number[];
}

/**
 * Parameters for evaluating whether a Copilot session that ended without
 * pushing new commits has nevertheless adequately addressed every
 * outstanding pull-request review comment.
 */
export interface EvaluateReviewCommentsAddressedParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
}

export type ReviewCommentsAddressedVerdict = "DONE" | "NOT_DONE";

export interface ReviewCommentsAddressedEvaluation {
  verdict: ReviewCommentsAddressedVerdict;
  rationale: string;
}

/**
 * Local Copilot chat client. The default implementation shells out to the
 * `copilot` CLI inside a fresh checkout of the PR branch so the CLI can
 * inspect the actual diff and commits.
 */
export interface LocalCopilotChatClient {
  generateFinalDescription(params: GenerateFinalDescriptionParams): Promise<string>;
  evaluateReviewCommentsAddressed(
    params: EvaluateReviewCommentsAddressedParams,
  ): Promise<ReviewCommentsAddressedEvaluation>;
}

interface LocalCopilotChatClientOptions {
  /**
   * Root directory under which per-PR checkouts are created.
   * Defaults to `~/.vibrator/checkouts`.
   */
  checkoutRootDir?: string;
  /** Path / command for the local `copilot` CLI. */
  copilotCommand?: string;
  /** Path / command for the `gh` CLI used to fetch the PR. */
  ghCommand?: string;
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
  // When true, capture stdout and return it; otherwise inherit stdio.
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

export const FINAL_DESCRIPTION_START_MARKER = "<<<VIBRATOR_PR_BODY_START>>>";
export const FINAL_DESCRIPTION_END_MARKER = "<<<VIBRATOR_PR_BODY_END>>>";

/**
 * Sentinel line emitted by the `copilot` CLI when evaluating whether
 * unresolved review comments on a PR have been adequately addressed. The
 * CLI must end its output with exactly `VERDICT: DONE` or
 * `VERDICT: NOT_DONE` (on its own line, optionally followed by a
 * rationale block).
 */
export const REVIEW_COMMENTS_VERDICT_PATTERN = /^VERDICT:\s*(DONE|NOT_DONE)\b/im;

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
    "Read the commits and diff on the current branch (use git log, git diff origin/main..HEAD, etc.) and produce a polished, accurate Markdown description summarizing what changed and why.",
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

/**
 * Extracts the final PR description from raw `copilot` CLI stdout, which
 * typically also contains the agent's interactive session transcript (tool
 * invocations, narration, etc.). The CLI is instructed (via the prompt) to
 * wrap the final description in sentinel markers; this function pulls out
 * that section. If the markers are missing, the raw output is returned
 * trimmed so the caller still gets *something* usable.
 */
export function extractFinalDescription(rawOutput: string): string {
  const startIndex = rawOutput.indexOf(FINAL_DESCRIPTION_START_MARKER);
  const endIndex = rawOutput.lastIndexOf(FINAL_DESCRIPTION_END_MARKER);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return rawOutput.trim();
  }
  const inner = rawOutput.slice(
    startIndex + FINAL_DESCRIPTION_START_MARKER.length,
    endIndex,
  );
  return inner.replace(/^\s*\r?\n/, "").replace(/\r?\n\s*$/, "").trim();
}

/**
 * Parses the verdict from raw `copilot` CLI output. The CLI is instructed
 * to emit a `VERDICT: DONE` or `VERDICT: NOT_DONE` sentinel line; the
 * remaining stdout is treated as the rationale. If no sentinel is found
 * the verdict is conservatively reported as NOT_DONE so the orchestrator
 * re-asks Copilot rather than auto-merging on an ambiguous answer.
 */
export function extractReviewCommentsVerdict(
  rawOutput: string,
): ReviewCommentsAddressedEvaluation {
  const match = rawOutput.match(REVIEW_COMMENTS_VERDICT_PATTERN);
  if (!match) {
    return { verdict: "NOT_DONE", rationale: rawOutput.trim() };
  }
  const verdict = match[1] === "DONE" ? "DONE" : "NOT_DONE";
  return { verdict, rationale: rawOutput.trim() };
}

function buildReviewCommentsEvaluationPrompt(
  params: EvaluateReviewCommentsAddressedParams,
): string {
  return [
    `You are evaluating whether every unresolved review comment on pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo} has been adequately addressed.`,
    "",
    "Context: the Copilot coding agent was asked to address the review comments but ended its turn without pushing new commits. It may have decided no code change was warranted (e.g. the existing code is already correct), or it may have failed to make the change. Your job is to decide which.",
    "",
    "Use the available tools to investigate. At minimum, inspect:",
    `- The unresolved review comments: \`gh pr view ${params.pullRequestNumber} --json reviews,comments,reviewThreads\` (or \`gh api\`).`,
    `- Copilot's most recent comment on the PR: \`gh pr view ${params.pullRequestNumber} --comments\`.`,
    "- The current diff and any commits on the branch: `git log` and `git diff origin/main..HEAD`.",
    "",
    "Decide one of:",
    "- DONE: every unresolved review comment is genuinely resolved by the code in its current state OR by a substantive explanation from Copilot that makes a code change unnecessary. The PR can safely proceed to the next stage (re-review, then merge).",
    "- NOT_DONE: at least one review comment still requires a code change that has not been made. The orchestrator will re-ask Copilot to address them.",
    "",
    "Output format requirements:",
    "- After your investigation, emit a single line `VERDICT: DONE` or `VERDICT: NOT_DONE` (exact prefix, on its own line).",
    "- Optionally, write a short rationale before or after that line.",
    "- The orchestrator only reads the VERDICT line, so be conservative: if you are not confident every comment is resolved, emit NOT_DONE.",
  ].join("\n");
}

class DefaultLocalCopilotChatClient implements LocalCopilotChatClient {
  private readonly checkoutRootDir: string;
  private readonly copilotCommand: string;
  private readonly ghCommand: string;

  constructor(options: LocalCopilotChatClientOptions = {}) {
    this.checkoutRootDir = options.checkoutRootDir ?? defaultCheckoutRootDir();
    this.copilotCommand = options.copilotCommand ?? "copilot";
    this.ghCommand = options.ghCommand ?? "gh";
  }

  async generateFinalDescription(params: GenerateFinalDescriptionParams): Promise<string> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });

    const prompt = buildFinalDescriptionPrompt(params);
    const stdout = await this.runCopilot(prompt, repoDir);
    return extractFinalDescription(stdout);
  }

  async evaluateReviewCommentsAddressed(
    params: EvaluateReviewCommentsAddressedParams,
  ): Promise<ReviewCommentsAddressedEvaluation> {
    const repoDir = await this.checkoutPullRequest(params);
    const prompt = buildReviewCommentsEvaluationPrompt(params);
    const stdout = await this.runCopilot(prompt, repoDir);
    return extractReviewCommentsVerdict(stdout);
  }

  private async checkoutPullRequest(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
  }): Promise<string> {
    const repoDir = join(
      this.checkoutRootDir,
      `${params.owner}-${params.repo}`,
      String(params.pullRequestNumber),
    );

    await mkdir(repoDir, { recursive: true });

    // Clone the repository (shallow) if not already present.
    const gitDir = join(repoDir, ".git");
    if (!(await pathExists(gitDir))) {
      await runCommand(
        this.ghCommand,
        ["repo", "clone", `${params.owner}/${params.repo}`, repoDir, "--", "--depth=50"],
      );
    }

    // Ensure `origin` fetches all branches into refs/remotes/origin/*. A
    // shallow / single-branch clone (which `gh repo clone --depth=50`
    // produces) configures `origin` with a narrow refspec covering only the
    // default branch, which causes `gh pr checkout` to fail with
    // "starting point 'origin/<branch>' is not a branch" because the
    // remote-tracking ref it just fetched isn't covered by the refspec.
    await runCommand(
      "git",
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: repoDir },
    );
    await runCommand("git", ["fetch", "origin", "--prune"], { cwd: repoDir });

    // Check out the PR branch into the existing repo. `gh pr checkout` handles
    // both same-repo and fork-PR cases.
    await runCommand(this.ghCommand, ["pr", "checkout", String(params.pullRequestNumber), "--force"], {
      cwd: repoDir,
    });

    return repoDir;
  }

  private async runCopilot(prompt: string, cwd: string): Promise<string> {
    // Strip GitHub token env vars so the `copilot` CLI falls back to its own
    // keyring-stored authentication. Inheriting GITHUB_TOKEN/GH_TOKEN from
    // vibrator's .env causes copilot to use a PAT that typically lacks the
    // "Copilot Requests" permission, producing an authentication failure.
    const copilotEnv: NodeJS.ProcessEnv = { ...process.env };
    delete copilotEnv.GITHUB_TOKEN;
    delete copilotEnv.GH_TOKEN;
    delete copilotEnv.COPILOT_GITHUB_TOKEN;
    return runCommand(this.copilotCommand, ["-p", prompt], {
      cwd,
      captureStdout: true,
      env: copilotEnv,
    });
  }
}

export function createLocalCopilotChatClient(
  options: LocalCopilotChatClientOptions = {},
): LocalCopilotChatClient {
  return new DefaultLocalCopilotChatClient(options);
}
