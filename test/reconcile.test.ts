import test from "node:test";
import assert from "node:assert/strict";

import { reconcileSessions } from "../src/reconcile.js";
import type { AgentSession } from "../src/types.js";

function createSession(
  overrides: Partial<AgentSession> & Pick<AgentSession, "id" | "phase" | "status">,
): AgentSession {
  return {
    id: overrides.id,
    issueNumber: overrides.issueNumber,
    phase: overrides.phase,
    status: overrides.status,
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.pullRequestNumber !== undefined
      ? { pullRequestNumber: overrides.pullRequestNumber }
      : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
  };
}

test("reconcileSessions fails every in_progress session as a crash carcass", async () => {
  const failed: string[] = [];
  const sessionStore = {
    async failSession(sessionId: string): Promise<AgentSession | undefined> {
      failed.push(sessionId);
      return undefined;
    },
  };

  const events = await reconcileSessions(sessionStore, [
    createSession({ id: "a", issueNumber: 1, phase: "implementation", status: "in_progress" }),
    createSession({ id: "b", issueNumber: 2, phase: "self-review", status: "completed" }),
    createSession({ id: "c", issueNumber: 3, phase: "self-review", status: "in_progress" }),
    createSession({ id: "d", issueNumber: 4, phase: "implementation", status: "failed" }),
  ]);

  assert.deepEqual(failed, ["a", "c"]);
  assert.deepEqual(
    events.map((e) => ({ id: e.session.id, outcome: e.outcome })),
    [
      { id: "a", outcome: "failed-stale" },
      { id: "c", outcome: "failed-stale" },
    ],
  );
});

test("reconcileSessions emits no events when nothing is in_progress", async () => {
  const sessionStore = {
    async failSession(): Promise<AgentSession | undefined> {
      throw new Error("should not be called");
    },
  };

  const events = await reconcileSessions(sessionStore, [
    createSession({ id: "x", issueNumber: 1, phase: "self-review", status: "completed" }),
  ]);

  assert.deepEqual(events, []);
});
