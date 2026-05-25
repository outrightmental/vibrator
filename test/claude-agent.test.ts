import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createClaudeAgentClient,
  extractFinalDescription,
  extractImplementationPayload,
  extractSelfReviewPayload,
  extractThinkingPreview,
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
  sanitizePullRequestTitle,
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

test("extractThinkingPreview returns all non-empty lines joined with newlines", () => {
  const chunk = "Reading file\nAnalyzing code\nFound the issue";
  assert.equal(extractThinkingPreview(chunk), "Reading file\nAnalyzing code\nFound the issue");
});

test("extractThinkingPreview strips ANSI escape sequences", () => {
  // ESC codes on the last (only) line -- stripping must fire for the assertion to hold.
  const chunk = "\x1b[32mGreen text\x1b[0m";
  assert.equal(extractThinkingPreview(chunk), "Green text");
});

test("extractThinkingPreview strips carriage returns", () => {
  const chunk = "line one\r\nline two\r\n";
  assert.equal(extractThinkingPreview(chunk), "line one\nline two");
});

test("extractThinkingPreview returns empty string for empty input", () => {
  assert.equal(extractThinkingPreview(""), "");
});

test("extractThinkingPreview returns empty string for whitespace-only input", () => {
  assert.equal(extractThinkingPreview("   \n   \n"), "");
});

test("extractThinkingPreview truncates individual lines longer than 200 characters", () => {
  const longLine = "x".repeat(250);
  const result = extractThinkingPreview(longLine);
  // 197 kept chars + 1 ellipsis char = 198
  assert.equal(result.length, 198);
  assert.ok(result.endsWith("…"));
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
        "if [ -f .git/MERGE_HEAD ]; then",
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

test("generateFinalDescription passes claudeCommitModel to claude CLI and closes stdin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-commit-model-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const modelLogPath = join(root, "model-used.txt");
  const stdinLogPath = join(root, "stdin-state.txt");
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
      assert.equal(modelUsed, "claude-haiku-test-model", "should pass claudeCommitModel to claude CLI");
      assert.equal(stdinState, "eof", "should close stdin for non-interactive Claude runs");
    } finally {
      // no env cleanup needed
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
