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
  FINAL_DESCRIPTION_END_MARKER,
  FINAL_DESCRIPTION_START_MARKER,
  IMPLEMENTATION_PAYLOAD_END_MARKER,
  IMPLEMENTATION_PAYLOAD_START_MARKER,
  isRebaseInProgress,
  isClaudeUsageLimitMessage,
  isNonFastForwardPushError,
  parseOriginHeadBranch,
  parseUsageResetTimeMs,
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

test("isClaudeUsageLimitMessage detects out-of-extra-usage text", () => {
  const message = "You're out of extra usage - resets 6:40pm (America/Los_Angeles)";
  assert.equal(isClaudeUsageLimitMessage(message), true);
});

test("isClaudeUsageLimitMessage returns false for unrelated errors", () => {
  assert.equal(isClaudeUsageLimitMessage("network timeout"), false);
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

test("implementIssue retries push by merging remote branch on non-fast-forward", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibrator-nff-test-"));
  const remoteDir = join(root, "remote.git");
  const seedDir = join(root, "seed");
  const binDir = join(root, "bin");
  const checkoutRootDir = join(root, "checkouts");
  const verifyDir = join(root, "verify");
  const ghStubPath = join(binDir, "gh-stub.sh");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const issueNumber = 173;
  const issueTitle = "Gift Certificates";
  const branch = "vibrator/issue-173-gift-certificates";

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", remoteDir], root);
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
      ghStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "if [ \"$1\" = \"repo\" ] && [ \"$2\" = \"clone\" ]; then",
        "  git clone \"$VIBRATOR_TEST_REMOTE\" \"$4\"",
        "  exit 0",
        "fi",
        "echo \"unsupported gh args: $*\" >&2",
        "exit 2",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghStubPath, 0o755);

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
        ghCommand: ghStubPath,
        claudeCommand: claudeStubPath,
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
  const ghStubPath = join(binDir, "gh-stub.sh");
  const claudeStubPath = join(binDir, "claude-stub.sh");
  const issueNumber = 173;
  const issueTitle = "Gift Certificates";
  const branch = "vibrator/issue-173-gift-certificates";

  await mkdir(binDir, { recursive: true });

  try {
    runOrThrow("git", ["init", "--bare", remoteDir], root);
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
      ghStubPath,
      [
        "#!/bin/sh",
        "set -eu",
        "if [ \"$1\" = \"repo\" ] && [ \"$2\" = \"clone\" ]; then",
        "  git clone \"$VIBRATOR_TEST_REMOTE\" \"$4\"",
        "  exit 0",
        "fi",
        "echo \"unsupported gh args: $*\" >&2",
        "exit 2",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghStubPath, 0o755);

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
        ghCommand: ghStubPath,
        claudeCommand: claudeStubPath,
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
