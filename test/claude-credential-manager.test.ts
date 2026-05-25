import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addClaudeCredential,
  activateClaudeCredential,
  credentialFilePathForEmail,
  listClaudeCredentials,
  removeClaudeCredential,
  saveClaudeCredential,
  type StoredClaudeCredential,
} from "../src/claude-credential-manager.js";

function createCredential(email: string, capturedAt: string): StoredClaudeCredential {
  return {
    provider: "claude-cli",
    email,
    platform: process.platform,
    capturedAt,
    authStatusText: `Signed in as ${email}`,
    credentialSecret: `secret-${email}`,
  };
}

test("credentialFilePathForEmail normalizes email into expected filename shape", () => {
  const path = credentialFilePathForEmail("User.Name+tag@example.com", "/tmp/store");
  assert.equal(path, join("/tmp/store", `${encodeURIComponent("user.name+tag@example.com")}.json`));
});

test("save/list/remove Claude credentials in ~/.vibrator-compatible JSON index", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-cred-"));
  try {
    await saveClaudeCredential(createCredential("b@example.com", "2026-01-02T00:00:00.000Z"), tmpDir);
    await saveClaudeCredential(createCredential("a@example.com", "2026-01-01T00:00:00.000Z"), tmpDir);
    await writeFile(join(tmpDir, "not-a-credential.txt"), "ignore me", "utf8");
    await writeFile(join(tmpDir, "broken.json"), "{\"x\":1}", "utf8");

    const listed = await listClaudeCredentials(tmpDir);
    assert.deepEqual(listed.map((entry) => entry.email), ["a@example.com", "b@example.com"]);

    const removed = await removeClaudeCredential("a@example.com", tmpDir);
    const removedMissing = await removeClaudeCredential("missing@example.com", tmpDir);
    assert.equal(removed, true);
    assert.equal(removedMissing, false);

    const afterRemove = await listClaudeCredentials(tmpDir);
    assert.deepEqual(afterRemove.map((entry) => entry.email), ["b@example.com"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("activateClaudeCredential writes credential into live .credentials.json on non-macOS platforms", async () => {
  if (process.platform === "darwin") {
    return;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-activate-"));
  try {
    const storeDir = join(tmpDir, "store");
    const claudeHomeDir = join(tmpDir, "claude-home");
    const credential = createCredential("activate@example.com", "2026-01-03T00:00:00.000Z");
    credential.credentialSecret = "{\"token\":\"abc\"}";
    await saveClaudeCredential(credential, storeDir);

    await activateClaudeCredential("activate@example.com", { storeDir, claudeHomeDir });
    const liveCredential = await readFile(join(claudeHomeDir, ".credentials.json"), "utf8");
    assert.equal(liveCredential, "{\"token\":\"abc\"}\n");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("addClaudeCredential scrubs GitHub tokens and sets CLAUDE_HOME for subprocesses", async () => {
  if (process.platform === "darwin") {
    return;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-add-cred-"));
  const original = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    VIBRATOR_GITHUB_TOKEN: process.env.VIBRATOR_GITHUB_TOKEN,
  };

  try {
    const storeDir = join(tmpDir, "store");
    const claudeHomeDir = join(tmpDir, "claude-home");
    await mkdir(claudeHomeDir, { recursive: true });
    await writeFile(join(claudeHomeDir, ".credentials.json"), "captured-secret\n", "utf8");

    process.env.GH_TOKEN = "gh-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    process.env.VIBRATOR_GITHUB_TOKEN = "vibrator-secret";

    const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const runCommandImpl: (
      command: string,
      args: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => Promise<{ stdout: string; stderr: string }> = async (_command, args, options = {}) => {
      capturedEnvs.push(options.env);
      if (args.length === 0) {
        return { stdout: "", stderr: "" };
      }
      assert.deepEqual(args, ["auth", "status", "--text"]);
      return { stdout: "Signed in as Added.User@example.com\n", stderr: "" };
    };

    const credential = await addClaudeCredential({
      storeDir,
      claudeCommand: "claude",
      claudeHomeDir,
      runCommandImpl,
    });

    assert.equal(credential.email, "added.user@example.com");
    assert.equal(credential.credentialSecret, "captured-secret");
    assert.equal(capturedEnvs.length, 2);
    for (const env of capturedEnvs) {
      assert.equal(env?.GH_TOKEN, undefined);
      assert.equal(env?.GITHUB_TOKEN, undefined);
      assert.equal(env?.VIBRATOR_GITHUB_TOKEN, undefined);
      assert.equal(env?.CLAUDE_HOME, claudeHomeDir);
    }
  } finally {
    if (original.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = original.GH_TOKEN;
    if (original.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = original.GITHUB_TOKEN;
    if (original.VIBRATOR_GITHUB_TOKEN === undefined) delete process.env.VIBRATOR_GITHUB_TOKEN;
    else process.env.VIBRATOR_GITHUB_TOKEN = original.VIBRATOR_GITHUB_TOKEN;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("addClaudeCredential treats empty CLAUDE_HOME env var as unset", async () => {
  if (process.platform === "darwin") {
    return;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-add-cred-empty-home-"));
  const originalHome = process.env.HOME;
  const originalClaudeHome = process.env.CLAUDE_HOME;

  try {
    const storeDir = join(tmpDir, "store");
    const fakeHome = join(tmpDir, "fake-home");
    const defaultClaudeHome = join(fakeHome, ".claude");
    await mkdir(defaultClaudeHome, { recursive: true });
    await writeFile(join(defaultClaudeHome, ".credentials.json"), "default-secret\n", "utf8");

    process.env.HOME = fakeHome;
    process.env.CLAUDE_HOME = "   ";

    const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const runCommandImpl: (
      command: string,
      args: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => Promise<{ stdout: string; stderr: string }> = async (_command, args, options = {}) => {
      capturedEnvs.push(options.env);
      if (args.length === 0) {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "Signed in as empty.home@example.com\n", stderr: "" };
    };

    const credential = await addClaudeCredential({
      storeDir,
      claudeCommand: "claude",
      runCommandImpl,
    });

    assert.equal(credential.credentialSecret, "default-secret");
    assert.equal(capturedEnvs.length, 2);
    for (const env of capturedEnvs) {
      assert.equal(env?.CLAUDE_HOME, undefined);
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = originalClaudeHome;
    await rm(tmpDir, { recursive: true, force: true });
  }
});
