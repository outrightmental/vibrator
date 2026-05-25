import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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
  assert.equal(path, "/tmp/store/user_dot_name_tag_at_example_dot_com.json");
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
