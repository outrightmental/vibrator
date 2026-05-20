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

test("FileSessionStore preserves multiple terminal sessions with the same key", async () => {
  await withTempStore(async (store) => {
    // Two terminal sessions with the same key — both should survive
    // so the orchestrator can detect consecutive clean self-reviews.
    const older = await store.createSession({
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
    assert.equal(reviewSessions.length, 2);
    assert.ok(reviewSessions.some((s) => s.id === older.id));
    assert.ok(reviewSessions.some((s) => s.id === newer.id));
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

test("FileSessionStore getLastReadCommentAt returns undefined when nothing recorded", async () => {
  await withTempStore(async (store) => {
    const result = await store.getLastReadCommentAt(42);
    assert.equal(result, undefined);
  });
});

test("FileSessionStore setLastReadCommentAt persists and getLastReadCommentAt retrieves it", async () => {
  await withTempStore(async (store) => {
    await store.setLastReadCommentAt(10, "2024-06-01T12:00:00.000Z");
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-01T12:00:00.000Z");
  });
});

test("FileSessionStore getPostedCommentIds returns an empty array when nothing recorded", async () => {
  await withTempStore(async (store) => {
    assert.deepEqual(await store.getPostedCommentIds(42), []);
  });
});

test("FileSessionStore recordPostedCommentId persists ids per PR without duplicates", async () => {
  await withTempStore(async (store) => {
    await store.recordPostedCommentId(10, 1001);
    await store.recordPostedCommentId(10, 1002);
    await store.recordPostedCommentId(10, 1001); // duplicate — ignored
    await store.recordPostedCommentId(11, 2001);

    assert.deepEqual(await store.getPostedCommentIds(10), [1001, 1002]);
    assert.deepEqual(await store.getPostedCommentIds(11), [2001]);
  });
});

test("FileSessionStore setLastReadCommentAt preserves existing sessions when updating", async () => {
  await withTempStore(async (store) => {
    await store.createSession({ issueNumber: 1, phase: "implementation", status: "completed" });
    await store.setLastReadCommentAt(5, "2024-06-01T00:00:00.000Z");
    const sessions = await store.load();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.issueNumber, 1);
  });
});

test("FileSessionStore setLastReadCommentAt updates existing timestamp for same PR", async () => {
  await withTempStore(async (store) => {
    await store.setLastReadCommentAt(10, "2024-06-01T00:00:00.000Z");
    await store.setLastReadCommentAt(10, "2024-06-02T00:00:00.000Z");
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-02T00:00:00.000Z");
  });
});

test("FileSessionStore createSession preserves lastReadPrComments", async () => {
  await withTempStore(async (store) => {
    await store.setLastReadCommentAt(10, "2024-06-01T12:00:00.000Z");
    await store.createSession({ issueNumber: 1, phase: "request-review", status: "completed" });
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-01T12:00:00.000Z", "createSession must not erase lastReadPrComments");
  });
});

test("FileSessionStore completeSession preserves lastReadPrComments", async () => {
  await withTempStore(async (store) => {
    const session = await store.createSession({ issueNumber: 1, phase: "self-review" });
    await store.setLastReadCommentAt(10, "2024-06-01T12:00:00.000Z");
    await store.completeSession(session.id, { madeChanges: false });
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-01T12:00:00.000Z", "completeSession must not erase lastReadPrComments");
  });
});
