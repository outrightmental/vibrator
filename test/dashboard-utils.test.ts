import test from "node:test";
import assert from "node:assert/strict";

import {
  broadcastPullRequestUpdate,
  broadcastCIStatus,
  broadcastIssueUpdate,
  broadcastCommit,
  broadcastReviewComment,
  broadcastRepositorySnapshot,
} from "../src/dashboard-utils.js";
import { globalEventEmitter } from "../src/event-emitter.js";
import type { DashboardEvent } from "../src/event-emitter.js";
import type { PullRequest, Issue, Commit, RepositorySnapshot } from "../src/types.js";

function captureNextEvent(eventType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const unsub = globalEventEmitter.subscribe((event: DashboardEvent) => {
      if (event.type === eventType) {
        unsub();
        resolve(event.data);
      }
    });
  });
}

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: "Test PR",
    body: "",
    headSha: "abc123",
    headRefName: "feature",
    baseRefName: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "open",
    draft: false,
    hasMergeConflicts: false,
    hasCleanReviewOnHead: false,
    unresolvedReviewCommentCount: 0,
    checksStatus: "success",
    headCommitPushedAt: undefined,
    closingIssueNumbers: [],
    linkedIssueNumbers: [],
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 7,
    title: "Test Issue",
    body: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "open",
    type: null,
    ...overrides,
  };
}

// broadcastPullRequestUpdate — monitoring branch

test("broadcastPullRequestUpdate emits structured fields for 'monitoring' action", async () => {
  const pr = makePR({ draft: false, checksStatus: "success" });
  const dataPromise = captureNextEvent("broadcast-pr-update");
  broadcastPullRequestUpdate(pr, "monitoring");
  const data = await dataPromise;

  assert.ok((data.stateBefore as string).includes("PR #42"), "stateBefore includes PR number");
  assert.ok((data.changeHow as string).includes("monitoring"), "changeHow uses the action");
  assert.ok((data.stateAfter as string).includes("OPEN"), "stateAfter includes state");
  assert.ok((data.excellence as string).length > 0, "excellence is populated");
});

test("broadcastPullRequestUpdate uses monitoring branch for 'tracking' action", async () => {
  const pr = makePR({ draft: true, checksStatus: "pending" });
  const dataPromise = captureNextEvent("broadcast-pr-update");
  broadcastPullRequestUpdate(pr, "tracking draft pending");
  const data = await dataPromise;

  assert.ok((data.changeHow as string).includes("tracking"), "changeHow mentions tracking");
  assert.ok((data.stateBefore as string).includes("draft"), "stateBefore mentions draft");
});

// broadcastPullRequestUpdate — non-monitoring branch

test("broadcastPullRequestUpdate uses non-monitoring branch for generic action", async () => {
  const pr = makePR({ hasCleanReviewOnHead: true });
  const dataPromise = captureNextEvent("broadcast-pr-update");
  broadcastPullRequestUpdate(pr, "merged to main");
  const data = await dataPromise;

  assert.equal(data.changeHow, "merged to main", "changeHow is the raw action string");
  assert.ok((data.excellence as string).includes("quality"), "clean-review excellence mentions quality");
  assert.ok(data.workerIndex === undefined, "workerIndex is undefined when not passed");
});

test("broadcastPullRequestUpdate excellence for CI-passing non-draft PR (no clean review)", async () => {
  const pr = makePR({ hasCleanReviewOnHead: false, checksStatus: "success", draft: false });
  const dataPromise = captureNextEvent("broadcast-pr-update");
  broadcastPullRequestUpdate(pr, "status updated");
  const data = await dataPromise;

  assert.ok((data.excellence as string).includes("merge"), "excellence mentions merge-ready");
});

test("broadcastPullRequestUpdate passes workerIndex through", async () => {
  const pr = makePR();
  const dataPromise = captureNextEvent("broadcast-pr-update");
  broadcastPullRequestUpdate(pr, "updated", 2);
  const data = await dataPromise;

  assert.equal(data.workerIndex, 2);
});

// broadcastCIStatus

test("broadcastCIStatus emits success structured fields", async () => {
  const dataPromise = captureNextEvent("broadcast-ci-status");
  broadcastCIStatus(99, "success");
  const data = await dataPromise;

  assert.ok((data.stateBefore as string).includes("99"), "stateBefore references PR number");
  assert.ok((data.stateAfter as string).includes("PASSED"), "stateAfter says PASSED");
  assert.ok((data.excellence as string).includes("merge"), "excellence mentions merge-ready");
});

test("broadcastCIStatus emits failure structured fields", async () => {
  const dataPromise = captureNextEvent("broadcast-ci-status");
  broadcastCIStatus(99, "failure", "lint failed");
  const data = await dataPromise;

  assert.ok((data.stateAfter as string).includes("FAILED"), "stateAfter says FAILED");
  assert.ok((data.stateAfter as string).includes("lint failed"), "stateAfter includes details");
  assert.ok((data.excellence as string).includes("caught"), "excellence acknowledges failure");
  assert.ok((data.changeHow as string).includes("lint failed"), "changeHow includes details");
});

test("broadcastCIStatus emits pending structured fields", async () => {
  const dataPromise = captureNextEvent("broadcast-ci-status");
  broadcastCIStatus(99, "pending");
  const data = await dataPromise;

  assert.ok((data.stateAfter as string).includes("RUNNING"), "stateAfter says RUNNING");
  assert.ok((data.excellence as string).includes("active"), "excellence is positive");
});

test("broadcastCIStatus falls back gracefully for unknown status", async () => {
  const dataPromise = captureNextEvent("broadcast-ci-status");
  broadcastCIStatus(99, "skipped");
  const data = await dataPromise;

  assert.ok((data.stateAfter as string).includes("SKIPPED"), "stateAfter includes uppercased status");
  assert.ok((data.excellence as string).length > 0, "excellence is populated");
});

// broadcastIssueUpdate

test("broadcastIssueUpdate emits 'opened' structured fields", async () => {
  const issue = makeIssue({ state: "open" });
  const dataPromise = captureNextEvent("broadcast-issue-update");
  broadcastIssueUpdate(issue, "opened");
  const data = await dataPromise;

  assert.equal(data.stateBefore, "Issue did not exist");
  assert.ok((data.stateAfter as string).includes("OPEN"), "stateAfter says OPEN");
  assert.ok((data.excellence as string).includes("queued"), "excellence mentions queued");
});

test("broadcastIssueUpdate emits 'closed' structured fields", async () => {
  const issue = makeIssue({ state: "closed" });
  const dataPromise = captureNextEvent("broadcast-issue-update");
  broadcastIssueUpdate(issue, "closed");
  const data = await dataPromise;

  assert.ok((data.stateBefore as string).includes("open"), "stateBefore mentions was-open");
  assert.ok((data.stateAfter as string).includes("CLOSED"), "stateAfter says CLOSED");
  assert.ok((data.excellence as string).includes("resolved"), "excellence celebrates closure");
});

test("broadcastIssueUpdate emits 'updated' structured fields for open issue", async () => {
  const issue = makeIssue({ state: "open" });
  const dataPromise = captureNextEvent("broadcast-issue-update");
  broadcastIssueUpdate(issue, "updated");
  const data = await dataPromise;

  assert.ok((data.stateBefore as string).includes("#7"), "stateBefore references issue number");
  assert.ok((data.excellence as string).includes("tracked"), "excellence mentions tracking");
});

// broadcastCommit

test("broadcastCommit emits structured fields", async () => {
  const commit: Commit = {
    hash: "deadbeef1234567",
    author: "Alice",
    message: "feat: add magic\n\nLonger description",
    pushedAt: new Date().toISOString(),
  };
  const dataPromise = captureNextEvent("broadcast-commit");
  broadcastCommit(commit);
  const data = await dataPromise;

  assert.ok((data.changeHow as string).includes("deadbee"), "changeHow includes short hash (7 chars)");
  assert.ok((data.changeHow as string).includes("Alice"), "changeHow includes author");
  assert.ok((data.stateAfter as string).includes("feat: add magic"), "stateAfter has first commit line only");
  assert.ok(!(data.stateAfter as string).includes("Longer description"), "stateAfter omits continuation lines");
  assert.ok((data.excellence as string).length > 0, "excellence is populated");
});

// broadcastReviewComment

test("broadcastReviewComment emits structured fields", async () => {
  const dataPromise = captureNextEvent("broadcast-review-comment");
  broadcastReviewComment(55, "Bob", 3);
  const data = await dataPromise;

  assert.ok((data.stateBefore as string).includes("55"), "stateBefore references PR number");
  assert.ok((data.changeHow as string).includes("Bob"), "changeHow includes reviewer");
  assert.ok((data.changeHow as string).includes("3"), "changeHow includes comment count");
  assert.ok((data.stateAfter as string).includes("3"), "stateAfter mentions comment count");
  assert.ok((data.excellence as string).length > 0, "excellence is populated");
  assert.equal(data.prNumber, 55);
});

// broadcastRepositorySnapshot — excellence variants

function makeSnapshot(overrides: {
  successCount?: number;
  failureCount?: number;
  pendingCount?: number;
} = {}): RepositorySnapshot {
  const { successCount = 0, failureCount = 0, pendingCount = 0 } = overrides;

  const makePRChecks = (status: "success" | "failure" | "pending", count: number): PullRequest[] =>
    Array.from({ length: count }, (_, i) => makePR({ number: i + 1, checksStatus: status, draft: false }));

  return {
    pullRequests: [
      ...makePRChecks("success", successCount),
      ...makePRChecks("failure", failureCount),
      ...makePRChecks("pending", pendingCount),
    ],
    issues: [],
    agentSessions: [],
  };
}

test("broadcastRepositorySnapshot excellence: all CI green", async () => {
  const snapshot = makeSnapshot({ successCount: 3 });
  const dataPromise = captureNextEvent("broadcast-github-activity");
  broadcastRepositorySnapshot(snapshot, "owner", "repo");
  const data = await dataPromise;

  assert.ok((data.excellence as string).includes("green"), "excellence mentions green CI");
  assert.ok((data.stateAfter as string).includes("3"), "stateAfter includes counts");
});

test("broadcastRepositorySnapshot excellence: CI failures present", async () => {
  const snapshot = makeSnapshot({ successCount: 1, failureCount: 2 });
  const dataPromise = captureNextEvent("broadcast-github-activity");
  broadcastRepositorySnapshot(snapshot, "owner", "repo");
  const data = await dataPromise;

  assert.ok((data.excellence as string).includes("2"), "excellence mentions failure count");
  assert.ok((data.excellence as string).includes("remediate"), "excellence mentions remediation");
});

test("broadcastRepositorySnapshot excellence: no checks at all", async () => {
  const snapshot = makeSnapshot({ successCount: 0, failureCount: 0, pendingCount: 0 });
  const dataPromise = captureNextEvent("broadcast-github-activity");
  broadcastRepositorySnapshot(snapshot, "owner", "repo");
  const data = await dataPromise;

  assert.ok((data.excellence as string).includes("visibility"), "excellence mentions visibility");
});

test("broadcastRepositorySnapshot includes repo in stateBefore", async () => {
  const snapshot = makeSnapshot();
  const dataPromise = captureNextEvent("broadcast-github-activity");
  broadcastRepositorySnapshot(snapshot, "myorg", "myrepo");
  const data = await dataPromise;

  assert.ok((data.stateBefore as string).includes("myorg/myrepo"), "stateBefore has owner/repo");
});
