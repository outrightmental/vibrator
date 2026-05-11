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
 * Local Copilot chat client. The default implementation shells out to the
 * `copilot` CLI inside a fresh checkout of the PR branch so the CLI can
 * inspect the actual diff and commits.
 */
export interface LocalCopilotChatClient {
  generateFinalDescription(params: GenerateFinalDescriptionParams): Promise<string>;
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

    const prompt = buildFinalDescriptionPrompt(params);
    // Strip GitHub token env vars so the `copilot` CLI falls back to its own
    // keyring-stored authentication. Inheriting GITHUB_TOKEN/GH_TOKEN from
    // vibrator's .env causes copilot to use a PAT that typically lacks the
    // "Copilot Requests" permission, producing an authentication failure.
    const copilotEnv: NodeJS.ProcessEnv = { ...process.env };
    delete copilotEnv.GITHUB_TOKEN;
    delete copilotEnv.GH_TOKEN;
    delete copilotEnv.COPILOT_GITHUB_TOKEN;
    const stdout = await runCommand(this.copilotCommand, ["-p", prompt], {
      cwd: repoDir,
      captureStdout: true,
      env: copilotEnv,
    });

    return extractFinalDescription(stdout);
  }
}

export function createLocalCopilotChatClient(
  options: LocalCopilotChatClientOptions = {},
): LocalCopilotChatClient {
  return new DefaultLocalCopilotChatClient(options);
}
