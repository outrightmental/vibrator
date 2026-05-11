import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileSessionStore } from "../src/session-store.js";
import type { AgentSession } from "../src/types.js";

async function createSessionStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vibrator-session-store-"));
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
