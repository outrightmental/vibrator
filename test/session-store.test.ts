import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSessionStore } from "../src/session-store.js";

async function withTempStore<T>(
  callback: (store: FileSessionStore, filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vibrator-session-test-"));
  const filePath = join(dir, "sessions.json");
  const store = new FileSessionStore(filePath);
  try {
    return await callback(store, filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("FileSessionStore returns an empty session list when the file does not exist", async () => {
  await withTempStore(async (store) => {
    assert.deepEqual(await store.load(), []);
  });
});

test("FileSessionStore createSession persists a new in_progress session by default", async () => {
  await withTempStore(async (store) => {
    const session = await store.createSession({
      issueNumber: 7,
      phase: "implementation",
    });
    assert.equal(session.status, "in_progress");
    assert.equal(session.issueNumber, 7);
    const sessions = await store.load();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, session.id);
  });
});

test("FileSessionStore createSession can persist a completed session in one call", async () => {
  await withTempStore(async (store) => {
    const session = await store.createSession({
      issueNumber: 1,
      phase: "implementation",
      status: "completed",
      result: { pullRequestHeadSha: "sha-1" },
    });
    assert.equal(session.status, "completed");
    assert.equal(session.completedAt, session.createdAt);
    assert.deepEqual(session.result, { pullRequestHeadSha: "sha-1" });
  });
});

test("FileSessionStore completeSession transitions an in_progress session", async () => {
  await withTempStore(async (store) => {
    const created = await store.createSession({
      issueNumber: 1,
      phase: "self-review",
    });
    const updated = await store.completeSession(created.id, { madeChanges: true });
    assert.ok(updated);
    assert.equal(updated!.status, "completed");
    assert.equal(updated!.result?.madeChanges, true);
  });
});

test("FileSessionStore failSession marks a session failed", async () => {
  await withTempStore(async (store) => {
    const created = await store.createSession({
      issueNumber: 1,
      phase: "implementation",
    });
    const failed = await store.failSession(created.id);
    assert.ok(failed);
    assert.equal(failed!.status, "failed");
    assert.ok(failed!.completedAt);
  });
});

test("FileSessionStore writes valid JSON to disk", async () => {
  await withTempStore(async (store, filePath) => {
    await store.createSession({ issueNumber: 1, phase: "implementation" });
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as { sessions: unknown[] };
    assert.equal(parsed.sessions.length, 1);
  });
});

test("FileSessionStore prunes terminal sessions beyond the cap, keeping the most recent per key", async () => {
  await withTempStore(async (store) => {
    // Two terminal sessions with the same key — only the newest should
    // survive pruning.
    await store.createSession({
      issueNumber: 1,
      phase: "self-review",
      status: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await store.createSession({
      issueNumber: 1,
      phase: "self-review",
      status: "completed",
    });
    const sessions = await store.load();
    const reviewSessions = sessions.filter(
      (s) => s.issueNumber === 1 && s.phase === "self-review",
    );
    assert.equal(reviewSessions.length, 1);
    assert.equal(reviewSessions[0]?.id, newer.id);
  });
});

test("FileSessionStore preserves active sessions through writes", async () => {
  await withTempStore(async (store) => {
    const active = await store.createSession({
      issueNumber: 5,
      phase: "implementation",
    });
    // Add unrelated terminal sessions
    await store.createSession({
      issueNumber: 6,
      phase: "self-review",
      status: "completed",
    });
    const sessions = await store.load();
    assert.ok(sessions.some((s) => s.id === active.id));
  });
});
