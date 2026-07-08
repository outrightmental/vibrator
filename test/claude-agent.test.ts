import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createClaudeAgentClient,
  extractFinalDescription,
  extractImplementationPayload,
  extractSelfReviewPayload,
  FINAL_DESCRIPTION_END_MARKER,
  FINAL_DESCRIPTION_START_MARKER,
  IMPLEMENTATION_PAYLOAD_END_MARKER,
  IMPLEMENTATION_PAYLOAD_START_MARKER,
  SELF_REVIEW_PAYLOAD_END_MARKER,
  SELF_REVIEW_PAYLOAD_START_MARKER,
  formatUserCommentsSection,
  isRebaseInProgress,
  isClaudeUsageLimitMessage,
  isClaudeTermsAcceptanceMessage,
  isNonFastForwardPushError,
  parseOriginHeadBranch,
  parseUsageResetTimeMs,
  runCommand,
  sanitizePullRequestTitle,
  validateClaudeAuth,
} from "../src/claude-agent.js";

function runOrThrow(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function mockSameRepoPullRequestFetch(
  t: test.TestContext,
  params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    branch: string;
    headSha: string;
    cloneUrl: string;
  },
): void {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert.equal(
        String(url),
        `https://api.github.com/repos/${params.owner}/${params.repo}/pulls/${params.pullRequestNumber}`,
      );
      const authorization = String(
        init?.headers && (init.headers as Record<string, string>).Authorization,
      );
      assert.equal(authorization.startsWith("Bearer "), true);
      return new Response(
        JSON.stringify({
          head: {
            ref: params.branch,
            sha: params.headSha,
            repo: {
              clone_url: params.cloneUrl,
              full_name: `${params.owner}/${params.repo}`,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  t.after(() => fetchMock.mock.restore());
}

test("extractFinalDescription returns the text between the sentinel markers", () => {
  const stdout = [
    "Tool: read file",
    "Some chatter...",
    FINAL_DESCRIPTION_START_MARKER,
    "## Summary",
    "",
    "Did the thing.",
    FINAL_DESCRIPTION_END_MARKER,
    "Tool: done",
  ].join("\n");

  assert.equal(extractFinalDescription(stdout), "## Summary\n\nDid the thing.");
});

test("extractFinalDescription falls back to the raw stdout when markers are missing", () => {
  const stdout = "Just a free-form description.";
  assert.equal(extractFinalDescription(stdout), "Just a free-form description.");
});

test("extractImplementationPayload parses the JSON body between markers", () => {
  const json = JSON.stringify({
    title: "Add widget",
    body: "Added the widget.\n\nCloses #1",
  });
  const stdout = [
    "chatter",
    IMPLEMENTATION_PAYLOAD_START_MARKER,
    json,
    IMPLEMENTATION_PAYLOAD_END_MARKER,
  ].join("\n");

  const result = extractImplementationPayload(stdout);
  assert.deepEqual(result, {
    pullRequestTitle: "Add widget",
    pullRequestBody: "Added the widget.\n\nCloses #1",
  });
});

test("extractImplementationPayload returns undefined when markers are missing", () => {
  assert.equal(extractImplementationPayload("no markers here"), undefined);
});

test("extractImplementationPayload returns undefined for malformed JSON", () => {
  const stdout = `${IMPLEMENTATION_PAYLOAD_START_MARKER}\nnot json\n${IMPLEMENTATION_PAYLOAD_END_MARKER}`;
  assert.equal(extractImplementationPayload(stdout), undefined);
});

test("extractImplementationPayload strips conventional-commit prefix from title", () => {
  const json = JSON.stringify({ title: "feat: add widget support", body: "Closes #1" });
  const stdout = [IMPLEMENTATION_PAYLOAD_START_MARKER, json, IMPLEMENTATION_PAYLOAD_END_MARKER].join("\n");
  const result = extractImplementationPayload(stdout);
  assert.equal(result?.pullRequestTitle, "Add widget support");
});

test("extractImplementationPayload capitalizes first letter of title", () => {
  const json = JSON.stringify({ title: "update the thing", body: "Closes #2" });
  const stdout = [IMPLEMENTATION_PAYLOAD_START_MARKER, json, IMPLEMENTATION_PAYLOAD_END_MARKER].join("\n");
  const result = extractImplementationPayload(stdout);
  assert.equal(result?.pullRequestTitle, "Update the thing");
});

test("sanitizePullRequestTitle removes simple type prefix", () => {
  assert.equal(sanitizePullRequestTitle("feat: add login"), "Add login");
});

test("sanitizePullRequestTitle removes scoped prefix with issue number", () => {
  assert.equal(sanitizePullRequestTitle("feat(#301): support dark mode"), "Support dark mode");
});

test("sanitizePullRequestTitle removes scoped prefix with text scope", () => {
  assert.equal(sanitizePullRequestTitle("fix(auth): handle expired tokens"), "Handle expired tokens");
});

test("sanitizePullRequestTitle capitalizes first letter when no prefix present", () => {
  assert.equal(sanitizePullRequestTitle("add dark mode toggle"), "Add dark mode toggle");
});

test("sanitizePullRequestTitle leaves already-correct titles unchanged", () => {
  assert.equal(sanitizePullRequestTitle("Add dark mode toggle"), "Add dark mode toggle");
});

test("sanitizePullRequestTitle handles chore prefix", () => {
  assert.equal(sanitizePullRequestTitle("chore: bump dependencies"), "Bump dependencies");
});

test("sanitizePullRequestTitle strips prefix when title has leading whitespace", () => {
  assert.equal(sanitizePullRequestTitle("  feat: add login"), "Add login");
});

test("sanitizePullRequestTitle does not strip capitalized word followed by colon", () => {
  assert.equal(sanitizePullRequestTitle("HTTP: standardize client headers"), "HTTP: standardize client headers");
});

test("sanitizePullRequestTitle removes breaking-change prefix (type!:)", () => {
  assert.equal(sanitizePullRequestTitle("feat!: drop legacy API"), "Drop legacy API");
});

test("sanitizePullRequestTitle removes breaking-change prefix with scope (type(scope)!:)", () => {
  assert.equal(sanitizePullRequestTitle("feat(auth)!: require MFA"), "Require MFA");
});

test("isClaudeUsageLimitMessage detects out-of-extra-usage text", () => {
  const message = "You're out of extra usage - resets 6:40pm (America/Los_Angeles)";
  assert.equal(isClaudeUsageLimitMessage(message), true);
});

test("isClaudeUsageLimitMessage returns false for unrelated errors", () => {
  assert.equal(isClaudeUsageLimitMessage("network timeout"), false);
});

test("isClaudeTermsAcceptanceMessage detects the consumer-terms API error", () => {
  const message =
    "API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.";
  assert.equal(isClaudeTermsAcceptanceMessage(message), true);
});

test("isClaudeTermsAcceptanceMessage returns false for unrelated errors", () => {
  assert.equal(isClaudeTermsAcceptanceMessage("network timeout"), false);
});

test("isNonFastForwardPushError detects git non-fast-forward push output", () => {
  const message = [
    "error: failed to push some refs to 'github.com:owner/repo.git'",
    "hint: Updates were rejected because the tip of your current branch is behind",
    "hint: its remote counterpart.",
  ].join("\n");
  assert.equal(isNonFastForwardPushError(message), true);
});

test("isNonFastForwardPushError returns false for unrelated push failures", () => {
  assert.equal(isNonFastForwardPushError("fatal: Authentication failed"), false);
});

test("parseUsageResetTimeMs parses same-day reset times", () => {
  const now = new Date(2026, 4, 14, 17, 0, 0, 0);
  const parsed = parseUsageResetTimeMs(
    "You're out of extra usage - resets 6:40pm (America/Los_Angeles)",
    now,
  );
  assert.equal(parsed !== undefined, true);
  const date = new Date(parsed!);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 14);
  assert.equal(date.getHours(), 18);
  assert.equal(date.getMinutes(), 40);
});

test("parseUsageResetTimeMs rolls to next day when time already passed", () => {
  const now = new Date(2026, 4, 14, 23, 0, 0, 0);
  const parsed = parseUsageResetTimeMs("usage limit reached, resets 6:40pm", now);
  assert.equal(parsed !== undefined, true);
  const date = new Date(parsed!);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 15);
  assert.equal(date.getHours(), 18);
  assert.equal(date.getMinutes(), 40);
});

test("parseUsageResetTimeMs returns undefined when reset time is missing", () => {
  assert.equal(parseUsageResetTimeMs("You're out of extra usage"), undefined);
});

test("parseOriginHeadBranch extracts branch from origin short ref", () => {
  assert.equal(parseOriginHeadBranch("origin/main"), "main");
});

test("parseOriginHeadBranch extracts branch from full remote ref path", () => {
  assert.equal(parseOriginHeadBranch("refs/remotes/origin/release/2026"), "release/2026");
});

test("parseOriginHeadBranch returns undefined for non-origin refs", () => {
  assert.equal(parseOriginHeadBranch("upstream/main"), undefined);
});

test("isRebaseInProgress returns true when rebase-merge exists", async () => {
  const exists = async (path: string): Promise<boolean> => path.endsWith("/.git/rebase-merge");
  const result = await isRebaseInProgress("/tmp/repo", exists);
  assert.equal(result, true);
});

test("isRebaseInProgress returns true when rebase-apply exists", async () => {
  const exists = async (path: string): Promise<boolean> => path.endsWith("/.git/rebase-apply");
  const result = await isRebaseInProgress("/tmp/repo", exists);
  assert.equal(result, true);
});

test("isRebaseInProgress returns false when no rebase state exists", async () => {
  const exists = async (): Promise<boolean> => false;
  const result = await isRebaseInProgress("/tmp/repo", exists);
  assert.equal(result, false);
});

// The credential reader is injected so these tests exercise the validation
// logic without depending on the host's real credential store (the macOS
// Keychain on darwin, a file elsewhere).
const fakeReader =
  (value: { raw: string } | { valid: boolean; reason?: string }) =>
  async () =>
    value;

test("validateClaudeAuth returns invalid when credentials are missing", async () => {
  const result = await validateClaudeAuth(
    fakeReader({ valid: false, reason: "credentials not found" }),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "credentials not found");
});

test("validateClaudeAuth returns invalid when credentials contain invalid JSON", async () => {
  const result = await validateClaudeAuth(fakeReader({ raw: "not-json" }));
  assert.equal(result.valid, false);
  assert.equal(result.reason, "credentials are not valid JSON");
});

test("validateClaudeAuth returns invalid when OAuth token is expired and has no refresh token", async () => {
  const credentials = { claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() - 10000 } };
  const result = await validateClaudeAuth(fakeReader({ raw: JSON.stringify(credentials) }));
  assert.equal(result.valid, false);
  assert.equal(result.reason, "OAuth token has expired");
});

test("validateClaudeAuth returns valid when access token is expired but a refresh token is present", async () => {
  // The Claude CLI silently refreshes an expired access token, so this is a
  // normal, valid state — not a reason to block startup.
  const credentials = {
    claudeAiOauth: { accessToken: "tok", refreshToken: "refresh", expiresAt: Date.now() - 10000 },
  };
  const result = await validateClaudeAuth(fakeReader({ raw: JSON.stringify(credentials) }));
  assert.equal(result.valid, true);
  assert.equal(result.reason, undefined);
});

test("validateClaudeAuth returns valid when OAuth token is not yet expired", async () => {
  const credentials = { claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3600000 } };
  const result = await validateClaudeAuth(fakeReader({ raw: JSON.stringify(credentials) }));
  assert.equal(result.valid, true);
  assert.equal(result.reason, undefined);
});

test("validateClaudeAuth returns valid when credentials have no expiry field", async () => {
  const credentials = { claudeAiOauth: { accessToken: "tok" } };
  const result = await validateClaudeAuth(fakeReader({ raw: JSON.stringify(credentials) }));
  assert.equal(result.valid, true);
});

test("validateClaudeAuth returns valid when credentials have no oauth section", async () => {
  const result = await validateClaudeAuth(fakeReader({ raw: JSON.stringify({ someOtherKey: "value" }) }));
  assert.equal(result.valid, true);
});

test("selfReview does not report changes when only merging latest base advances HEAD", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-self-review-base-merge-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const verifyDir = join(root, "verify");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const prBranch = "feature/no-op-review";

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    // PR branch starts equal to main (no branch-specific commits).
    runOrThrow("git", ["checkout", "-b", prBranch], seedDir);
    runOrThrow("git", ["push", "-u", "origin", prBranch], seedDir);
    const prBranchHeadBeforeMainAdvance = runOrThrow("git", ["rev-parse", "HEAD"], seedDir);

    // Advance main to simulate a merge-from-main update that does not come from review edits.
    runOrThrow("git", ["checkout", "main"], seedDir);
    await writeFile(join(seedDir, "main-only.txt"), "new content from main\n", "utf8");
    runOrThrow("git", ["add", "main-only.txt"], seedDir);
    runOrThrow("git", ["commit", "-m", "advance main"], seedDir);
    runOrThrow("git", ["push", "origin", "main"], seedDir);
    const mainHeadAfterAdvance = runOrThrow("git", ["rev-parse", "HEAD"], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "echo LGTM",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    mockSameRepoPullRequestFetch(t, {
      owner: "example",
      repo: "repo",
      pullRequestNumber: 77,
      branch: prBranch,
      headSha: prBranchHeadBeforeMainAdvance,
      cloneUrl: remoteDir,
    });

    try {
      const client = createClaudeAgentClient({
        checkoutRootDir,
        claudeCommand: claudeStubPath,
        githubToken: "test-token",
        repositoryCloneUrl: remoteDir,
        claudeTimeoutMs: 120000,
      });

      const result = await client.selfReview({
        owner: "example",
        repo: "repo",
        pullRequestNumber: 77,
        pullRequestTitle: "No-op self review",
        pullRequestBody: "Body",
        headRefName: prBranch,
        baseRefName: "main",
      });

      assert.equal(result.madeChanges, false);
      assert.notEqual(result.headSha, prBranchHeadBeforeMainAdvance);
      assert.equal(result.headSha, mainHeadAfterAdvance);

      runOrThrow("git", ["clone", remoteDir, verifyDir], root);
      runOrThrow("git", ["checkout", prBranch], verifyDir);
      const remotePrHead = runOrThrow("git", ["rev-parse", "HEAD"], verifyDir);
      assert.equal(remotePrHead, mainHeadAfterAdvance);
      const status = runOrThrow("git", ["status", "--porcelain"], verifyDir);
      assert.equal(status, "");
    } finally {
      // no env cleanup needed
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Shell snippet that parses `--model <value>` and `--effort <value>` from the
// claude CLI arguments and writes them to the given log files.
function captureModelAndEffortSnippet(modelLogPath: string, effortLogPath: string): string[] {
  return [
    "MODEL_USED=\"(none)\"",
    "EFFORT_USED=\"(none)\"",
    "while [ $# -gt 0 ]; do",
    "  if [ \"$1\" = \"--model\" ] && [ $# -gt 1 ]; then",
    "    MODEL_USED=\"$2\"",
    "    shift 2",
    "  elif [ \"$1\" = \"--effort\" ] && [ $# -gt 1 ]; then",
    "    EFFORT_USED=\"$2\"",
    "    shift 2",
    "  else",
    "    shift",
    "  fi",
    "done",
    `printf '%s' "$MODEL_USED" > "${modelLogPath}"`,
    `printf '%s' "$EFFORT_USED" > "${effortLogPath}"`,
  ];
}

test("implementIssue passes claudeInitialModel and claudeInitialEffort to the claude CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-initial-model-effort-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const modelLogPath = join(root, "model-used.txt");
  const effortLogPath = join(root, "effort-used.txt");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const issueNumber = 301;
  const issueTitle = "Initial model wiring";
  const branch = "vibrator/issue-301-initial-model-wiring";

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);
    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        ...captureModelAndEffortSnippet(modelLogPath, effortLogPath),
        "git config user.name \"Claude Stub\"",
        "git config user.email \"claude-stub@example.com\"",
        "echo \"fresh implementation\" >> implementation.txt",
        "git add implementation.txt",
        "git commit -m \"agent implementation commit\"",
        `echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "echo '{\"title\":\"Initial model wiring\",\"body\":\"Closes #301\"}'",
        `echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    const client = createClaudeAgentClient({
      checkoutRootDir,
      claudeCommand: claudeStubPath,
      githubToken: "test-token",
      repositoryCloneUrl: remoteDir,
      claudeTimeoutMs: 120000,
      claudeInitialModel: "claude-sonnet-4-6",
      claudeInitialEffort: "high",
      claudeReviewModel: "claude-opus-4-8",
      claudeReviewEffort: "medium",
    });

    const result = await client.implementIssue({
      owner: "example",
      repo: "repo",
      issueNumber,
      issueTitle,
      issueBody: "Wire the initial model.",
      baseBranch: "main",
    });

    assert.equal(result.branch, branch);
    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(modelLogPath, "utf8")).trim(), "claude-sonnet-4-6");
    assert.equal((await readFile(effortLogPath, "utf8")).trim(), "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selfReview passes claudeReviewModel and claudeReviewEffort to the claude CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-review-model-effort-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const modelLogPath = join(root, "model-used.txt");
  const effortLogPath = join(root, "effort-used.txt");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const prBranch = "feature/review-model-effort";
  const prNumber = 88;

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);
    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);
    runOrThrow("git", ["checkout", "-b", prBranch], seedDir);
    runOrThrow("git", ["push", "-u", "origin", prBranch], seedDir);
    const prHeadSha = runOrThrow("git", ["rev-parse", "HEAD"], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        ...captureModelAndEffortSnippet(modelLogPath, effortLogPath),
        "echo LGTM",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    mockSameRepoPullRequestFetch(t, {
      owner: "example",
      repo: "repo",
      pullRequestNumber: prNumber,
      branch: prBranch,
      headSha: prHeadSha,
      cloneUrl: remoteDir,
    });

    const client = createClaudeAgentClient({
      checkoutRootDir,
      claudeCommand: claudeStubPath,
      githubToken: "test-token",
      repositoryCloneUrl: remoteDir,
      claudeTimeoutMs: 120000,
      claudeInitialModel: "claude-sonnet-4-6",
      claudeInitialEffort: "high",
      claudeReviewModel: "claude-opus-4-8",
      claudeReviewEffort: "medium",
    });

    await client.selfReview({
      owner: "example",
      repo: "repo",
      pullRequestNumber: prNumber,
      pullRequestTitle: "Review model wiring",
      pullRequestBody: "Body",
      headRefName: prBranch,
      baseRefName: "main",
    });

    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(modelLogPath, "utf8")).trim(), "claude-opus-4-8");
    assert.equal((await readFile(effortLogPath, "utf8")).trim(), "medium");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implementIssue cleans stale uncommitted state left by a prior interrupted run", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-stale-checkout-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const verifyDir = join(root, "verify");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const issueNumber = 298;
  const issueTitle = "Affiliate Program Enhancements";
  const branch = "vibrator/issue-298-affiliate-program-enhancements";

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    await writeFile(join(seedDir, "tracked.txt"), "original contents\n", "utf8");
    runOrThrow("git", ["add", "README.md", "tracked.txt"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "git config user.name \"Claude Stub\"",
        "git config user.email \"claude-stub@example.com\"",
        "echo \"fresh implementation\" >> implementation.txt",
        "git add implementation.txt",
        "git commit -m \"agent implementation commit\"",
        `echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "echo '{\"title\":\"Affiliate Program Enhancements\",\"body\":\"Closes #298\"}'",
        `echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    // Simulate a prior interrupted run: the per-issue checkout dir exists
    // with leftover uncommitted modifications and untracked files that
    // would otherwise make `git checkout -B` abort with
    // "Your local changes ... would be overwritten by checkout".
    const issueCheckoutDir = join(checkoutRootDir, "example-repo", `issue-${issueNumber}`);
    await mkdir(issueCheckoutDir, { recursive: true });
    runOrThrow("git", ["clone", remoteDir, issueCheckoutDir], root);
    runOrThrow("git", ["config", "user.name", "Prior Run"], issueCheckoutDir);
    runOrThrow("git", ["config", "user.email", "prior@example.com"], issueCheckoutDir);
    // Put the dir on a stale feature branch with uncommitted changes,
    // matching the real-world failure where the prior run had switched
    // to vibrator/issue-N-... and left modifications.
    runOrThrow("git", ["checkout", "-b", branch], issueCheckoutDir);
    await writeFile(join(issueCheckoutDir, "tracked.txt"), "PRIOR INTERRUPTED EDIT\n", "utf8");
    await writeFile(join(issueCheckoutDir, "stale-untracked.txt"), "leftover\n", "utf8");

    try {
      const client = createClaudeAgentClient({
        checkoutRootDir,
        claudeCommand: claudeStubPath,
        githubToken: "test-token",
        repositoryCloneUrl: remoteDir,
        claudeTimeoutMs: 120000,
      });

      const result = await client.implementIssue({
        owner: "example",
        repo: "repo",
        issueNumber,
        issueTitle,
        issueBody: "Improve affiliate program.",
        baseBranch: "main",
      });

      assert.equal(result.branch, branch);

      runOrThrow("git", ["clone", remoteDir, verifyDir], root);
      runOrThrow("git", ["checkout", branch], verifyDir);
      const history = runOrThrow("git", ["log", "--format=%s", "-n", "20"], verifyDir);
      assert.match(history, /agent implementation commit/);
      // The prior interrupted edits must NOT have made it into the pushed branch.
      assert.doesNotMatch(history, /PRIOR INTERRUPTED EDIT/);
    } finally {
      // no env cleanup needed
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implementIssue retries push by merging remote branch on non-fast-forward", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-nff-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const verifyDir = join(root, "verify");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const issueNumber = 173;
  const issueTitle = "Gift Certificates";
  const branch = "vibrator/issue-173-gift-certificates";

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    runOrThrow("git", ["checkout", "-b", branch], seedDir);
    await writeFile(join(seedDir, "existing.txt"), "existing remote branch state\n", "utf8");
    runOrThrow("git", ["add", "existing.txt"], seedDir);
    runOrThrow("git", ["commit", "-m", "existing remote branch commit"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", branch], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "git config user.name \"Claude Stub\"",
        "git config user.email \"claude-stub@example.com\"",
        "echo \"local change\" >> local.txt",
        "git add local.txt",
        "git commit -m \"agent local commit\"",
        "RACE_DIR=\"$(mktemp -d \"${TMPDIR:-/tmp}/vibrator-race-XXXXXX\")\"",
        "git clone \"$VIBRATOR_TEST_REMOTE\" \"$RACE_DIR/repo\" >/dev/null 2>&1",
        "cd \"$RACE_DIR/repo\"",
        "git checkout \"$VIBRATOR_TEST_BRANCH\" >/dev/null 2>&1",
        "git config user.name \"Race Writer\"",
        "git config user.email \"race@example.com\"",
        "echo \"remote race change\" >> race.txt",
        "git add race.txt",
        "git commit -m \"race remote commit\" >/dev/null 2>&1",
        "git push origin \"$VIBRATOR_TEST_BRANCH\" >/dev/null 2>&1",
        `echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "echo '{\"title\":\"Test PR\",\"body\":\"Closes #173\"}'",
        `echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    const previousRemote = process.env.VIBRATOR_TEST_REMOTE;
    const previousBranch = process.env.VIBRATOR_TEST_BRANCH;
    process.env.VIBRATOR_TEST_REMOTE = remoteDir;
    process.env.VIBRATOR_TEST_BRANCH = branch;

    try {
      const client = createClaudeAgentClient({
        checkoutRootDir,
        claudeCommand: claudeStubPath,
        githubToken: "test-token",
        repositoryCloneUrl: remoteDir,
        claudeTimeoutMs: 120000,
      });

      const result = await client.implementIssue({
        owner: "example",
        repo: "repo",
        issueNumber,
        issueTitle,
        issueBody: "Add gift certificates support.",
        baseBranch: "main",
      });

      assert.equal(result.branch, branch);

      runOrThrow("git", ["clone", remoteDir, verifyDir], root);
      runOrThrow("git", ["checkout", branch], verifyDir);
      const history = runOrThrow("git", ["log", "--format=%s", "-n", "20"], verifyDir);
      const remoteHeadSha = runOrThrow("git", ["rev-parse", "HEAD"], verifyDir);

      assert.match(history, /existing remote branch commit/);
      assert.match(history, /agent local commit/);
      assert.match(history, /race remote commit/);
      assert.equal(result.headSha, remoteHeadSha);
    } finally {
      if (previousRemote === undefined) {
        delete process.env.VIBRATOR_TEST_REMOTE;
      } else {
        process.env.VIBRATOR_TEST_REMOTE = previousRemote;
      }
      if (previousBranch === undefined) {
        delete process.env.VIBRATOR_TEST_BRANCH;
      } else {
        process.env.VIBRATOR_TEST_BRANCH = previousBranch;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implementIssue resolves merge conflicts during non-fast-forward push recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-nff-conflict-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const verifyDir = join(root, "verify");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const issueNumber = 173;
  const issueTitle = "Gift Certificates";
  const branch = "vibrator/issue-173-gift-certificates";

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    await writeFile(join(seedDir, "shared.txt"), "base branch value\n", "utf8");
    runOrThrow("git", ["add", "README.md", "shared.txt"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    runOrThrow("git", ["checkout", "-b", branch], seedDir);
    await writeFile(join(seedDir, "existing.txt"), "existing remote branch state\n", "utf8");
    runOrThrow("git", ["add", "existing.txt"], seedDir);
    runOrThrow("git", ["commit", "-m", "existing remote branch commit"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", branch], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "git config user.name \"Claude Stub\"",
        "git config user.email \"claude-stub@example.com\"",
        "GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null || echo \".git\")",
        "if [ -f \"$GIT_DIR/MERGE_HEAD\" ]; then",
        "  echo \"resolved by claude\" > shared.txt",
        "  git add shared.txt",
        "  git commit -m \"resolve push conflict\"",
        `  echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "  echo '{\"title\":\"Test PR\",\"body\":\"Closes #173\"}'",
        `  echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "  exit 0",
        "fi",
        "echo \"local agent change\" > shared.txt",
        "git add shared.txt",
        "git commit -m \"agent local commit\"",
        "RACE_DIR=\"$(mktemp -d \"${TMPDIR:-/tmp}/vibrator-race-conflict-XXXXXX\")\"",
        "git clone \"$VIBRATOR_TEST_REMOTE\" \"$RACE_DIR/repo\" >/dev/null 2>&1",
        "cd \"$RACE_DIR/repo\"",
        "git checkout \"$VIBRATOR_TEST_BRANCH\" >/dev/null 2>&1",
        "git config user.name \"Race Writer\"",
        "git config user.email \"race@example.com\"",
        "echo \"remote race change\" > shared.txt",
        "git add shared.txt",
        "git commit -m \"race remote conflicting commit\" >/dev/null 2>&1",
        "git push origin \"$VIBRATOR_TEST_BRANCH\" >/dev/null 2>&1",
        `echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "echo '{\"title\":\"Test PR\",\"body\":\"Closes #173\"}'",
        `echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    const previousRemote = process.env.VIBRATOR_TEST_REMOTE;
    const previousBranch = process.env.VIBRATOR_TEST_BRANCH;
    process.env.VIBRATOR_TEST_REMOTE = remoteDir;
    process.env.VIBRATOR_TEST_BRANCH = branch;

    try {
      const client = createClaudeAgentClient({
        checkoutRootDir,
        claudeCommand: claudeStubPath,
        githubToken: "test-token",
        repositoryCloneUrl: remoteDir,
        claudeTimeoutMs: 120000,
      });

      const result = await client.implementIssue({
        owner: "example",
        repo: "repo",
        issueNumber,
        issueTitle,
        issueBody: "Add gift certificates support.",
        baseBranch: "main",
      });

      assert.equal(result.branch, branch);

      runOrThrow("git", ["clone", remoteDir, verifyDir], root);
      runOrThrow("git", ["checkout", branch], verifyDir);
      const history = runOrThrow("git", ["log", "--format=%s", "-n", "30"], verifyDir);
      const headFileContent = runOrThrow("git", ["show", "HEAD:shared.txt"], verifyDir);
      const remoteHeadSha = runOrThrow("git", ["rev-parse", "HEAD"], verifyDir);

      assert.match(history, /existing remote branch commit/);
      assert.match(history, /agent local commit/);
      assert.match(history, /race remote conflicting commit/);
      assert.match(history, /resolve push conflict/);
      assert.equal(headFileContent, "resolved by claude");
      assert.equal(result.headSha, remoteHeadSha);
    } finally {
      if (previousRemote === undefined) {
        delete process.env.VIBRATOR_TEST_REMOTE;
      } else {
        process.env.VIBRATOR_TEST_REMOTE = previousRemote;
      }
      if (previousBranch === undefined) {
        delete process.env.VIBRATOR_TEST_BRANCH;
      } else {
        process.env.VIBRATOR_TEST_BRANCH = previousBranch;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implementIssue force-pushes when remote branch is created after a fresh start", async () => {
  // Scenario: the feature branch does NOT exist when implementIssue begins
  // (branchAlreadyExistsRemotely = false), so we start fresh from origin/main.
  // Mid-way through Claude's work a race process creates the remote branch with
  // a different commit.  Our push is rejected as non-fast-forward.  Because we
  // started fresh, our implementation is authoritative: we should force-push and
  // overwrite the stale race commit rather than merging it in.
  const root = await mkdtemp(join(tmpdir(), "vibrator-force-push-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const verifyDir = join(root, "verify");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const issueNumber = 174;
  const issueTitle = "Force Push Test";
  const branch = "vibrator/issue-174-force-push-test";

  await mkdir(binDir, { recursive: true });

  try {
    // Remote starts with only a main branch — no feature branch yet.
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);
    // Intentionally NOT pushing the feature branch — it must not exist yet.

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "git config user.name \"Claude Stub\"",
        "git config user.email \"claude-stub@example.com\"",
        "echo \"fresh implementation\" > implementation.txt",
        "git add implementation.txt",
        "git commit -m \"fresh agent implementation commit\"",
        // Race: a concurrent process creates the feature branch on remote from
        // main with a completely different commit.  This makes our upcoming push
        // a non-fast-forward.
        "RACE_DIR=\"$(mktemp -d \"${TMPDIR:-/tmp}/vibrator-force-push-race-XXXXXX\")\"",
        "git clone \"$VIBRATOR_TEST_REMOTE\" \"$RACE_DIR/repo\" >/dev/null 2>&1",
        "cd \"$RACE_DIR/repo\"",
        "git checkout -b \"$VIBRATOR_TEST_BRANCH\" >/dev/null 2>&1",
        "git config user.name \"Race Writer\"",
        "git config user.email \"race@example.com\"",
        "echo \"stale content\" > stale.txt",
        "git add stale.txt",
        "git commit -m \"stale race commit that should be overwritten\" >/dev/null 2>&1",
        "git push origin \"$VIBRATOR_TEST_BRANCH\" >/dev/null 2>&1",
        `echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "echo '{\"title\":\"Test PR\",\"body\":\"Closes #174\"}'",
        `echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    const previousRemote = process.env.VIBRATOR_TEST_REMOTE;
    const previousBranch = process.env.VIBRATOR_TEST_BRANCH;
    process.env.VIBRATOR_TEST_REMOTE = remoteDir;
    process.env.VIBRATOR_TEST_BRANCH = branch;

    try {
      const client = createClaudeAgentClient({
        checkoutRootDir,
        claudeCommand: claudeStubPath,
        githubToken: "test-token",
        repositoryCloneUrl: remoteDir,
        claudeTimeoutMs: 120000,
      });

      const result = await client.implementIssue({
        owner: "example",
        repo: "repo",
        issueNumber,
        issueTitle,
        issueBody: "Implement the force-push test feature.",
        baseBranch: "main",
      });

      assert.equal(result.branch, branch);

      runOrThrow("git", ["clone", remoteDir, verifyDir], root);
      runOrThrow("git", ["checkout", branch], verifyDir);
      const history = runOrThrow("git", ["log", "--format=%s", "-n", "20"], verifyDir);
      const remoteHeadSha = runOrThrow("git", ["rev-parse", "HEAD"], verifyDir);

      // Our fresh implementation commit must be present on the remote.
      assert.match(history, /fresh agent implementation commit/);
      // The stale race commit must have been overwritten by the force-push.
      assert.doesNotMatch(history, /stale race commit/);
      assert.equal(result.headSha, remoteHeadSha);
    } finally {
      if (previousRemote === undefined) {
        delete process.env.VIBRATOR_TEST_REMOTE;
      } else {
        process.env.VIBRATOR_TEST_REMOTE = previousRemote;
      }
      if (previousBranch === undefined) {
        delete process.env.VIBRATOR_TEST_BRANCH;
      } else {
        process.env.VIBRATOR_TEST_BRANCH = previousBranch;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateFinalDescription passes claudeCommitModel to claude CLI and closes stdin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-commit-model-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const modelLogPath = join(root, "model-used.txt");
  const stdinLogPath = join(root, "stdin-state.txt");
  const tokenEnvLogPath = join(root, "token-env.txt");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const prBranch = "feature/commit-model-test";
  const prNumber = 42;

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    runOrThrow("git", ["checkout", "-b", prBranch], seedDir);
    await writeFile(join(seedDir, "feature.txt"), "feature work\n", "utf8");
    runOrThrow("git", ["add", "feature.txt"], seedDir);
    runOrThrow("git", ["commit", "-m", "add feature"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", prBranch], seedDir);
    const prHeadSha = runOrThrow("git", ["rev-parse", "HEAD"], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "STDIN_STATE=$(node -e \"const timer = setTimeout(() => { process.stdout.write('waiting'); process.exit(0); }, 200); process.stdin.on('end', () => { clearTimeout(timer); process.stdout.write('eof'); }); process.stdin.once('data', () => { clearTimeout(timer); process.stdout.write('data'); }); process.stdin.resume();\")",
        `printf '%s' \"$STDIN_STATE\" > \"${stdinLogPath}\"`,
        `printf '%s|%s|%s' "\${GH_TOKEN:-unset}" "\${GITHUB_TOKEN:-unset}" "\${VIBRATOR_GITHUB_TOKEN:-unset}" > \"${tokenEnvLogPath}\"`,
        // Capture model arg: parse --model <value> from $@
        "MODEL_USED=\"(none)\"",
        "while [ $# -gt 0 ]; do",
        "  if [ \"$1\" = \"--model\" ] && [ $# -gt 1 ]; then",
        "    MODEL_USED=\"$2\"",
        "    shift 2",
        "  else",
        "    shift",
        "  fi",
        "done",
        `printf '%s' "$MODEL_USED" > \"${modelLogPath}\"`,
        `echo \"${FINAL_DESCRIPTION_START_MARKER}\"`,
        "echo \"## Summary\"",
        "echo \"Did the thing.\"",
        `echo \"${FINAL_DESCRIPTION_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    mockSameRepoPullRequestFetch(t, {
      owner: "example",
      repo: "repo",
      pullRequestNumber: prNumber,
      branch: prBranch,
      headSha: prHeadSha,
      cloneUrl: remoteDir,
    });
    const previousTokens = {
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      VIBRATOR_GITHUB_TOKEN: process.env.VIBRATOR_GITHUB_TOKEN,
    };
    process.env.GH_TOKEN = "gh-token";
    process.env.GITHUB_TOKEN = "github-token";
    process.env.VIBRATOR_GITHUB_TOKEN = "vibrator-token";

    try {
      const client = createClaudeAgentClient({
        checkoutRootDir,
        claudeCommand: claudeStubPath,
        githubToken: "test-token",
        repositoryCloneUrl: remoteDir,
        claudeTimeoutMs: 120000,
        claudeCommitModel: "claude-haiku-test-model",
      });

      const description = await client.generateFinalDescription({
        owner: "example",
        repo: "repo",
        pullRequestNumber: prNumber,
        pullRequestTitle: "Test PR",
        pullRequestBody: "Body",
        headRefName: prBranch,
        baseRefName: "main",
        closingIssueNumbers: [],
      });

      assert.ok(description.includes("Did the thing."), "should return extracted description");
      const { readFile } = await import("node:fs/promises");
      const modelUsed = (await readFile(modelLogPath, "utf8")).trim();
      const stdinState = (await readFile(stdinLogPath, "utf8")).trim();
      const tokenEnv = (await readFile(tokenEnvLogPath, "utf8")).trim();
      assert.equal(modelUsed, "claude-haiku-test-model", "should pass claudeCommitModel to claude CLI");
      assert.equal(stdinState, "eof", "should close stdin for non-interactive Claude runs");
      assert.equal(tokenEnv, "unset|unset|unset", "should strip GitHub token env vars from Claude");
    } finally {
      for (const [key, value] of Object.entries(previousTokens)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatUserCommentsSection returns empty array when no comments provided", () => {
  assert.deepEqual(formatUserCommentsSection(undefined), []);
  assert.deepEqual(formatUserCommentsSection([]), []);
});

test("formatUserCommentsSection formats comments with author, date, and body", () => {
  const comments = [
    { author: "alice", body: "Please add more tests", createdAt: "2024-02-01T10:00:00.000Z" },
    { author: "bob", body: "Consider edge cases", createdAt: "2024-02-02T08:00:00.000Z" },
  ];
  const result = formatUserCommentsSection(comments);
  assert.ok(result.length > 0, "should produce non-empty output");
  const joined = result.join("\n");
  assert.ok(joined.includes("alice"), "should include first comment author");
  assert.ok(joined.includes("Please add more tests"), "should include first comment body");
  assert.ok(joined.includes("bob"), "should include second comment author");
  assert.ok(joined.includes("Consider edge cases"), "should include second comment body");
  assert.ok(joined.includes("Human comments on this PR"), "should include header text");
});

test("formatUserCommentsSection numbers each comment so the agent can reference it", () => {
  const result = formatUserCommentsSection([
    { author: "alice", body: "First", createdAt: "2024-02-01T10:00:00.000Z" },
    { author: "bob", body: "Second", createdAt: "2024-02-02T08:00:00.000Z" },
  ]).join("\n");
  assert.ok(result.includes("[Comment 1] **alice**"), "first comment is labelled");
  assert.ok(result.includes("[Comment 2] **bob**"), "second comment is labelled");
});

test("extractSelfReviewPayload parses per-comment responses", () => {
  const raw = [
    "Some transcript noise.",
    SELF_REVIEW_PAYLOAD_START_MARKER,
    JSON.stringify({
      commentResponses: [
        { index: 1, response: "Added the favicon." },
        { index: 2, response: "Wrote tests." },
      ],
    }),
    SELF_REVIEW_PAYLOAD_END_MARKER,
    "More noise.",
  ].join("\n");
  const responses = extractSelfReviewPayload(raw);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0], { index: 1, response: "Added the favicon." });
  assert.deepEqual(responses[1], { index: 2, response: "Wrote tests." });
});

test("extractSelfReviewPayload returns an empty array for missing or malformed payloads", () => {
  assert.deepEqual(extractSelfReviewPayload("no payload here"), []);
  assert.deepEqual(
    extractSelfReviewPayload(
      `${SELF_REVIEW_PAYLOAD_START_MARKER}\nnot json\n${SELF_REVIEW_PAYLOAD_END_MARKER}`,
    ),
    [],
  );
  // Entries missing required fields are skipped individually.
  const partial = extractSelfReviewPayload(
    [
      SELF_REVIEW_PAYLOAD_START_MARKER,
      JSON.stringify({
        commentResponses: [{ index: 1 }, { index: 2, response: "kept" }],
      }),
      SELF_REVIEW_PAYLOAD_END_MARKER,
    ].join("\n"),
  );
  assert.deepEqual(partial, [{ index: 2, response: "kept" }]);
});

test("runCommand kills the entire child process group on timeout, not just the direct child", async () => {
  // Spawn a shell that launches a detached grandchild sleeper and prints its
  // pid, then sleeps itself. The OLD behavior (child.kill on the direct child
  // only) left the grandchild alive after the timeout fired; the fix kills the
  // whole process group, so the grandchild must be gone.
  const script =
    "sleep 30 & " + // grandchild — outlives the direct child unless the group is killed
    'echo "GRANDCHILD:$!"; ' +
    "wait";

  let captured = "";
  await assert.rejects(
    runCommand("sh", ["-c", script], {
      captureStdout: true,
      onStdoutChunk: (chunk) => {
        captured += chunk;
      },
      timeoutMs: 300,
    }),
    /timed out/,
  );

  const match = captured.match(/GRANDCHILD:(\d+)/);
  assert.ok(match, `expected to capture grandchild pid, got: ${JSON.stringify(captured)}`);
  const grandchildPid = Number.parseInt(match![1]!, 10);

  // Give the SIGTERM→SIGKILL escalation a moment to tear the group down.
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Signal 0 only checks for existence; ESRCH means the process is gone.
  let stillAlive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch (error) {
    stillAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (stillAlive) {
    // Don't leak the sleeper if the assertion is about to fail.
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  assert.equal(stillAlive, false, `grandchild pid ${grandchildPid} survived the timeout`);
});

test("runCommand reaps process-group stragglers when the direct child exits normally", async () => {
  // The direct shell exits cleanly (no `wait`) but leaves a detached sleeper
  // behind. Before the fix, the normal-completion path only deleted the child
  // from the registry and never group-killed, so the sleeper reparented to
  // launchd and lived on — the exact ~1 GB-apiece orphan that exhausted memory
  // over an overnight run. The sleeper's stdio is redirected away from our
  // capture pipe so `close` fires promptly either way: this isolates the group
  // reap (without the fix the sleeper is plainly still alive when the promise
  // resolves; with it, the group SIGKILL has taken it down).
  const script =
    "sleep 30 >/dev/null 2>&1 & " + // straggler — outlives the leader unless the group is reaped
    'echo "GRANDCHILD:$!"';

  const stdout = await runCommand("sh", ["-c", script], {
    captureStdout: true,
    // No timeout: this is the happy path, not the timeout path.
  });

  const match = stdout.match(/GRANDCHILD:(\d+)/);
  assert.ok(match, `expected to capture grandchild pid, got: ${JSON.stringify(stdout)}`);
  const grandchildPid = Number.parseInt(match![1]!, 10);

  // Give the SIGKILL a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 200));

  let stillAlive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch (error) {
    stillAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (stillAlive) {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  assert.equal(stillAlive, false, `straggler pid ${grandchildPid} survived normal completion`);
});

test("implementIssue creates a canonical clone and uses linked worktrees for task directories", async () => {
  // Verifies that the new optimized checkout strategy:
  // 1. Clones the repo once into a shared `_main` canonical directory.
  // 2. Creates task directories as linked git worktrees (`.git` is a file, not
  //    a directory), avoiding a full network clone per issue.
  // 3. Reuses the canonical clone without re-cloning for a second task.
  const root = await mkdtemp(join(tmpdir(), "vibrator-canonical-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const claudeStubPath = join(binDir, "claude-stub.sh");

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "git config user.name \"Claude Stub\"",
        "git config user.email \"claude-stub@example.com\"",
        "echo \"implementation\" >> impl.txt",
        "git add impl.txt",
        "git commit -m \"agent commit\"",
        `echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "echo '{\"title\":\"Test\",\"body\":\"Closes #1\"}'",
        `echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    const client = createClaudeAgentClient({
      checkoutRootDir,
      claudeCommand: claudeStubPath,
      githubToken: "test-token",
      repositoryCloneUrl: remoteDir,
      claudeTimeoutMs: 120000,
    });

    // First task implementation.
    await client.implementIssue({
      owner: "example",
      repo: "repo",
      issueNumber: 1,
      issueTitle: "First task",
      issueBody: "Do something.",
      baseBranch: "main",
    });

    // Verify that the canonical clone was created.
    const canonicalDir = join(checkoutRootDir, "example-repo", "_main");
    const canonicalGitStat = await stat(join(canonicalDir, ".git"));
    assert.ok(canonicalGitStat.isDirectory(), "canonical _main/.git should be a directory");

    // Verify that the first task directory uses a linked worktree.
    const taskDir1 = join(checkoutRootDir, "example-repo", "issue-1");
    const taskGitStat1 = await stat(join(taskDir1, ".git"));
    assert.ok(taskGitStat1.isFile(), "task directory .git should be a file (linked worktree)");

    // Second task — should reuse the canonical clone, not clone again.
    await client.implementIssue({
      owner: "example",
      repo: "repo",
      issueNumber: 2,
      issueTitle: "Second task",
      issueBody: "Do something else.",
      baseBranch: "main",
    });

    // Verify that the second task directory is also a linked worktree.
    const taskDir2 = join(checkoutRootDir, "example-repo", "issue-2");
    const taskGitStat2 = await stat(join(taskDir2, ".git"));
    assert.ok(taskGitStat2.isFile(), "second task directory .git should be a file (linked worktree)");

    // Both tasks should share the same canonical clone's git objects directory.
    const canonicalObjectsPath = join(canonicalDir, ".git", "objects");
    const canonicalObjStat = await stat(canonicalObjectsPath);
    assert.ok(canonicalObjStat.isDirectory(), "canonical objects directory should exist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implementIssue repairs a leftover interrupted clone with an unborn HEAD", async () => {
  // Regression: an older version (or an interrupted `git clone`) can leave a
  // task directory whose `.git` is a *directory* with an origin remote and
  // fetched objects but an UNBORN HEAD (`ref: refs/heads/main`, no commit).
  // The backward-compat path treated any `.git` directory as a healthy clone
  // and ran `git reset --hard HEAD`, which fails forever with
  // "ambiguous argument 'HEAD'", so the engine could never make progress.
  // The checkout must detect the unusable HEAD and recreate the directory as a
  // linked worktree instead of looping.
  const root = await mkdtemp(join(tmpdir(), "vibrator-unborn-head-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const claudeStubPath = join(binDir, "claude-stub.sh");

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", "-b", "main", remoteDir], root);
    runOrThrow("git", ["clone", remoteDir, seedDir], root);
    runOrThrow("git", ["config", "user.name", "Seed User"], seedDir);
    runOrThrow("git", ["config", "user.email", "seed@example.com"], seedDir);

    await writeFile(join(seedDir, "README.md"), "# test\n", "utf8");
    runOrThrow("git", ["add", "README.md"], seedDir);
    runOrThrow("git", ["commit", "-m", "initial main commit"], seedDir);
    runOrThrow("git", ["branch", "-M", "main"], seedDir);
    runOrThrow("git", ["push", "-u", "origin", "main"], seedDir);

    // Recreate the broken state: a task directory that is a regular `.git`
    // directory which fetched from origin but never created a local commit.
    const taskDir = join(checkoutRootDir, "example-repo", "issue-1");
    await mkdir(taskDir, { recursive: true });
    runOrThrow("git", ["init", "-b", "main", taskDir], root);
    runOrThrow("git", ["remote", "add", "origin", remoteDir], taskDir);
    runOrThrow("git", ["fetch", "origin"], taskDir);
    // Sanity-check that the leftover really has an unborn HEAD.
    const headProbe = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: taskDir,
    });
    assert.notEqual(headProbe.status, 0, "leftover checkout should have an unborn HEAD");

    await writeFile(
      claudeStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "git config user.name \"Claude Stub\"",
        "git config user.email \"claude-stub@example.com\"",
        "echo \"implementation\" >> impl.txt",
        "git add impl.txt",
        "git commit -m \"agent commit\"",
        `echo \"${IMPLEMENTATION_PAYLOAD_START_MARKER}\"`,
        "echo '{\"title\":\"Test\",\"body\":\"Closes #1\"}'",
        `echo \"${IMPLEMENTATION_PAYLOAD_END_MARKER}\"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(claudeStubPath, 0o755);

    const client = createClaudeAgentClient({
      checkoutRootDir,
      claudeCommand: claudeStubPath,
      githubToken: "test-token",
      repositoryCloneUrl: remoteDir,
      claudeTimeoutMs: 120000,
    });

    // This previously threw (or never converged) on `git reset --hard HEAD`.
    await client.implementIssue({
      owner: "example",
      repo: "repo",
      issueNumber: 1,
      issueTitle: "First task",
      issueBody: "Do something.",
      baseBranch: "main",
    });

    // The broken directory must have been recreated as a linked worktree.
    const taskGitStat = await stat(join(taskDir, ".git"));
    assert.ok(
      taskGitStat.isFile(),
      "repaired task directory .git should be a file (linked worktree)",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand kills a grandchild that left the process group (setsid escape)", async () => {
  // This is the leak that group-only killing could not reach: `claude` spawns
  // its Bash tool calls / MCP servers / node workers in their OWN process
  // groups, so `kill(-leaderPid)` never signals them — they survive, reparent
  // to launchd, and hold ~1 GB apiece. Here a perl grandchild calls setsid() to
  // become its own session/group leader (ppid still points at the shell while
  // it lives, but its pgid is its own pid). The fix walks the descendant tree
  // by pid, so it must take the grandchild down even though it escaped the
  // group.
  // The grandchild's stdio is redirected to /dev/null so it does NOT hold our
  // capture pipe open — otherwise `close` would not fire until the sleeper ends
  // on its own (30 s), and the assertion would check a process that already
  // exited naturally rather than one our teardown had to kill. The shell echoes
  // the grandchild pid ($!) so we learn it without the grandchild touching the
  // pipe. With stdio detached, `close` fires as soon as the leader is killed,
  // so a surviving out-of-group grandchild is plainly still alive at check time.
  const script =
    "perl -e 'use POSIX (); POSIX::setsid(); sleep 30' >/dev/null 2>&1 & " +
    'echo "GRANDCHILD:$!"; ' +
    "wait";

  let captured = "";
  await assert.rejects(
    runCommand("sh", ["-c", script], {
      captureStdout: true,
      onStdoutChunk: (chunk) => {
        captured += chunk;
      },
      timeoutMs: 400,
    }),
    /timed out/,
  );

  const match = captured.match(/GRANDCHILD:(\d+)/);
  assert.ok(match, `expected to capture grandchild pid, got: ${JSON.stringify(captured)}`);
  const grandchildPid = Number.parseInt(match![1]!, 10);

  // Confirm the grandchild really did leave the leader's process group, so this
  // test exercises the descendant-by-pid path rather than the group kill.
  const psOut = spawnSync("ps", ["-o", "pid=,pgid=", "-p", String(grandchildPid)], {
    encoding: "utf8",
  }).stdout.trim();
  const pgidMatch = /^(\d+)\s+(\d+)$/.exec(psOut);
  if (pgidMatch) {
    assert.equal(
      pgidMatch[1],
      pgidMatch[2],
      "expected the setsid grandchild to lead its own process group",
    );
  }

  // Give the SIGTERM→SIGKILL escalation a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 300));

  let stillAlive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch (error) {
    stillAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (stillAlive) {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  assert.equal(
    stillAlive,
    false,
    `out-of-group grandchild pid ${grandchildPid} survived — group-only kill missed it`,
  );
});

test("runCommand reaps a group-escaped grandchild on NORMAL completion of a short run", async () => {
  // The overnight OOM regression: on the *normal-completion* path (no timeout),
  // the leader is already dead when teardown runs, so the fresh downward snapshot
  // from its pid is empty and cannot see a setsid grandchild that has reparented
  // to launchd. The only defense is the descendants recorded by the periodic
  // sweep *while the leader was alive*. At the old 5 s cadence a run shorter than
  // 5 s finished before the first tick fired, so nothing was ever recorded and
  // the ~1 GB grandchild leaked. This exercises that exact case: a leader that
  // lives longer than the (1 s) sweep interval but well under 5 s, a grandchild
  // that leaves the group via setsid(), and a clean exit — so the reap must come
  // from the recorded pid/pgid, not the group backstop or a live snapshot.
  const script =
    "perl -e 'use POSIX (); POSIX::setsid(); sleep 30' >/dev/null 2>&1 & " +
    'echo "GRANDCHILD:$!"; ' +
    "sleep 3"; // outlive the 1 s sweep so it records the grandchild; no `wait`, so exit is clean

  const stdout = await runCommand("sh", ["-c", script], {
    captureStdout: true,
    // No timeout: this is the happy path. Teardown fires from `close`, by which
    // point the leader is gone and only the recorded pid/pgid can find the escapee.
  });

  const match = stdout.match(/GRANDCHILD:(\d+)/);
  assert.ok(match, `expected to capture grandchild pid, got: ${JSON.stringify(stdout)}`);
  const grandchildPid = Number.parseInt(match![1]!, 10);

  // Confirm the grandchild really left the leader's group (own pgid), so this
  // covers the reparent-proof pgid path rather than claude's own-group backstop.
  const psOut = spawnSync("ps", ["-o", "pid=,pgid=", "-p", String(grandchildPid)], {
    encoding: "utf8",
  }).stdout.trim();
  const pgidMatch = /^(\d+)\s+(\d+)$/.exec(psOut);
  if (pgidMatch) {
    assert.equal(
      pgidMatch[1],
      pgidMatch[2],
      "expected the setsid grandchild to lead its own process group",
    );
  }

  // Give the SIGKILL a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 300));

  let stillAlive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch (error) {
    stillAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (stillAlive) {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  assert.equal(
    stillAlive,
    false,
    `escaped grandchild pid ${grandchildPid} survived normal completion — the sweep never recorded it`,
  );
});
