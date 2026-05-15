import test from "node:test";
import assert from "node:assert/strict";

import { broadcastLifecycleUpdate, type LifecyclePair } from "../src/dashboard-utils.js";
import { globalEventEmitter, type DashboardEvent } from "../src/event-emitter.js";
import type { Issue, PullRequest, RepositorySnapshot } from "../src/types.js";

function createIssue(overrides: Partial<Issue> & Pick<Issue, "number">): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    body: overrides.body ?? "",
    state: overrides.state ?? "open",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    type: overrides.type ?? null,
  };
}

function createPR(overrides: Partial<PullRequest> & Pick<PullRequest, "number">): PullRequest {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    body: overrides.body ?? "",
    headSha: overrides.headSha ?? `sha-${overrides.number}`,
    headRefName: overrides.headRefName ?? `branch-${overrides.number}`,
    baseRefName: overrides.baseRefName ?? "main",
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    hasMergeConflicts: overrides.hasMergeConflicts ?? false,
    hasCleanReviewOnHead: overrides.hasCleanReviewOnHead ?? false,
    unresolvedReviewCommentCount: overrides.unresolvedReviewCommentCount ?? 0,
    checksStatus: overrides.checksStatus ?? "success",
    headCommitPushedAt: overrides.headCommitPushedAt,
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    closingIssueNumbers: overrides.closingIssueNumbers ?? [],
    linkedIssueNumbers: overrides.linkedIssueNumbers ?? [],
  };
}

function captureNextLifecycleEvent(): Promise<DashboardEvent> {
  return new Promise((resolve) => {
    const unsub = globalEventEmitter.subscribe((event) => {
      if (event.type === "lifecycle-update") {
        unsub();
        resolve(event);
      }
    });
  });
}

test("broadcastLifecycleUpdate emits pairs sorted by issue number", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 3 }),
      createIssue({ number: 1 }),
      createIssue({ number: 2 }),
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const eventP = captureNextLifecycleEvent();
  broadcastLifecycleUpdate(snapshot);
  const event = await eventP;

  const pairs = event.data.pairs as LifecyclePair[];
  assert.equal(pairs.length, 3);
  assert.deepEqual(
    pairs.map((p) => p.issue.number),
    [1, 2, 3],
  );
});

test("broadcastLifecycleUpdate: issue with no PR gets absent prPhase", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 5 })],
    pullRequests: [],
    agentSessions: [],
  };

  const eventP = captureNextLifecycleEvent();
  broadcastLifecycleUpdate(snapshot);
  const event = await eventP;

  const pairs = event.data.pairs as LifecyclePair[];
  assert.equal(pairs[0]?.prPhase, "absent");
  assert.equal(pairs[0]?.pr, null);
});

test("broadcastLifecycleUpdate: issue in planning set gets planning prPhase", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [],
    agentSessions: [],
  };

  const eventP = captureNextLifecycleEvent();
  broadcastLifecycleUpdate(snapshot, new Set([7]));
  const event = await eventP;

  const pairs = event.data.pairs as LifecyclePair[];
  assert.equal(pairs[0]?.prPhase, "planning");
});

test("broadcastLifecycleUpdate: open PR paired via closingIssueNumbers gets active prPhase", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 10 })],
    pullRequests: [createPR({ number: 20, closingIssueNumbers: [10] })],
    agentSessions: [],
  };

  const eventP = captureNextLifecycleEvent();
  broadcastLifecycleUpdate(snapshot);
  const event = await eventP;

  const pairs = event.data.pairs as LifecyclePair[];
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.prPhase, "active");
  assert.equal(pairs[0]?.pr?.number, 20);
});

test("broadcastLifecycleUpdate: closed PR paired via closingIssueNumbers gets completed prPhase", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 11 })],
    pullRequests: [createPR({ number: 21, closingIssueNumbers: [11], state: "closed" })],
    agentSessions: [],
  };

  const eventP = captureNextLifecycleEvent();
  broadcastLifecycleUpdate(snapshot);
  const event = await eventP;

  const pairs = event.data.pairs as LifecyclePair[];
  assert.equal(pairs[0]?.prPhase, "completed");
});

test("broadcastLifecycleUpdate: falls back to linkedIssueNumbers when no closing refs", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 12 })],
    pullRequests: [createPR({ number: 22, closingIssueNumbers: [], linkedIssueNumbers: [12] })],
    agentSessions: [],
  };

  const eventP = captureNextLifecycleEvent();
  broadcastLifecycleUpdate(snapshot);
  const event = await eventP;

  const pairs = event.data.pairs as LifecyclePair[];
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.pr?.number, 22);
});

test("broadcastLifecycleUpdate: colorIndex is stable (issueNumber % 6)", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 6 }), createIssue({ number: 7 }), createIssue({ number: 13 })],
    pullRequests: [],
    agentSessions: [],
  };

  const eventP = captureNextLifecycleEvent();
  broadcastLifecycleUpdate(snapshot);
  const event = await eventP;

  const pairs = event.data.pairs as LifecyclePair[];
  assert.equal(pairs.find((p) => p.issue.number === 6)?.colorIndex, 0);  // 6 % 6
  assert.equal(pairs.find((p) => p.issue.number === 7)?.colorIndex, 1);  // 7 % 6
  assert.equal(pairs.find((p) => p.issue.number === 13)?.colorIndex, 1); // 13 % 6
});
