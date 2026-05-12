import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileSessionStore } from "../src/session-store.js";
import type { AgentSession } from "../src/types.js";

async function createSessionStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sdlc-session-store-"));
  return join(directory, "sessions.json");
}

test("save keeps active sessions and the latest terminal session for each phase", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);
  const sessions: AgentSession[] = [
    {
      id: "completed-old",
      issueNumber: 1,
      phase: "review",
      status: "completed",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: "completed-new",
      issueNumber: 1,
      phase: "review",
      status: "completed",
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      completedAt: "2024-01-02T00:00:00.000Z",
    },
    {
      id: "active",
      issueNumber: 2,
      phase: "implementation",
      status: "in_progress",
      createdAt: "2024-01-03T00:00:00.000Z",
      updatedAt: "2024-01-03T00:00:00.000Z",
    },
  ];

  await sessionStore.save(sessions);

  assert.deepEqual((await sessionStore.load()).map((session) => session.id), [
    "completed-new",
    "active",
  ]);
});

test("failStaleSessions marks old active sessions as failed", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        sessions: [
          {
            id: "stale",
            issueNumber: 1,
            phase: "implementation",
            status: "in_progress",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
          {
            id: "fresh",
            issueNumber: 2,
            phase: "review",
            status: "in_progress",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T01:45:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const failedSessions = await sessionStore.failStaleSessions(
    30 * 60 * 1000,
    Date.parse("2024-01-01T02:00:00.000Z"),
  );

  assert.deepEqual(failedSessions.map((session) => session.id), ["stale"]);
  const persistedSessions = await sessionStore.load();
  assert.equal(persistedSessions.find((session) => session.id === "stale")?.status, "failed");
  assert.equal(
    persistedSessions.find((session) => session.id === "fresh")?.status,
    "in_progress",
  );
});

test("save writes valid JSON to disk", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);

  await sessionStore.save([
    {
      id: "session-1",
      issueNumber: 1,
      phase: "implementation",
      status: "completed",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:00:00.000Z",
    },
  ]);

  const contents = await readFile(filePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(contents));
});

test("createSession generates unique ids", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);

  const first = await sessionStore.createSession({
    issueNumber: 1,
    phase: "implementation",
  });
  const second = await sessionStore.createSession({
    issueNumber: 1,
    phase: "implementation",
  });

  assert.notEqual(first.id, second.id);
});

test("save replaces an existing session file on repeated writes", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);

  await sessionStore.save([
    {
      id: "session-1",
      issueNumber: 1,
      phase: "implementation",
      status: "completed",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:00:00.000Z",
    },
  ]);
  await sessionStore.save([
    {
      id: "session-2",
      issueNumber: 2,
      phase: "review",
      status: "completed",
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      completedAt: "2024-01-02T00:00:00.000Z",
    },
  ]);

  const persistedSessions = await sessionStore.load();
  assert.deepEqual(persistedSessions.map((session) => session.id), ["session-2"]);
});

test("getRateLimitedUntil returns undefined when no pause has been recorded", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);

  // Missing file is treated as "no pause".
  assert.equal(await sessionStore.getRateLimitedUntil(), undefined);

  // Saving sessions without any pause must not introduce a pause.
  await sessionStore.save([]);
  assert.equal(await sessionStore.getRateLimitedUntil(), undefined);
});

test("setRateLimitedUntil persists across reads and survives save()", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);

  const until = new Date("2026-05-11T13:00:00.000Z");
  await sessionStore.setRateLimitedUntil(until);

  assert.equal(
    (await sessionStore.getRateLimitedUntil())?.toISOString(),
    until.toISOString(),
  );

  // save() must not clobber the persisted rate-limit marker — the
  // orchestrator routinely calls save() during normal operation and the
  // pause needs to outlive those writes.
  await sessionStore.save([
    {
      id: "session-1",
      issueNumber: 1,
      phase: "implementation",
      status: "in_progress",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ]);

  assert.equal(
    (await sessionStore.getRateLimitedUntil())?.toISOString(),
    until.toISOString(),
  );
});

test("setRateLimitedUntil(undefined) clears a previously persisted pause", async () => {
  const filePath = await createSessionStorePath();
  const sessionStore = new FileSessionStore(filePath);

  await sessionStore.setRateLimitedUntil(new Date("2026-05-11T13:00:00.000Z"));
  await sessionStore.setRateLimitedUntil(undefined);

  assert.equal(await sessionStore.getRateLimitedUntil(), undefined);
});
