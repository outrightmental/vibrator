import test from "node:test";
import assert from "node:assert/strict";

import {
  broadcastPullRequestUpdate,
  broadcastCIStatus,
  broadcastIssueUpdate,
  broadcastCommit,
  broadcastReviewComment,
  broadcastRepositorySnapshot,
  broadcastLifecycleUpdate,
  broadcastGitHubRateLimit,
  broadcastGitHubRateLimitCleared,
  hasPrStateChanged,
  filterNewCommits,
} from "../src/dashboard-utils.js";
import { globalEventEmitter } from "../src/event-emitter.js";
import type { DashboardEvent } from "../src/event-emitter.js";
import type { PullRequest, Issue, Commit, RepositorySnapshot } from "../src/types.js";
import type { GitHubRateLimitHold } from "../src/github-rate-limit.js";

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
    labels: [],
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
    labels: [],
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

test("broadcastGitHubRateLimit emits machine-readable hold payload", async () => {
  const hold: GitHubRateLimitHold = {
    kind: "secondary",
    api: "rest",
    blockedUntilMs: 123_456,
    waitMs: 60_000,
    reason: "Secondary limit",
    attempt: 2,
    statusCode: 403,
    operation: "list-issues",
    method: "GET",
    path: "/repos/o/r/issues",
    snapshot: {
      observedAtMs: 1,
      api: "rest",
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAtMs: 120_000,
      retryAfterMs: 60_000,
    },
  };

  const dataPromise = captureNextEvent("github-rate-limit");
  broadcastGitHubRateLimit(hold);
  const data = await dataPromise;
  assert.equal(data.kind, "secondary");
  assert.equal(data.api, "rest");
  assert.equal(data.blockedUntilMs, 123_456);
  assert.equal(data.waitMs, 60_000);
  assert.equal(data.remaining, 0);
  assert.equal(data.operation, "list-issues");
});

test("broadcastGitHubRateLimitCleared emits cleared event", async () => {
  const dataPromise = captureNextEvent("github-rate-limit-cleared");
  broadcastGitHubRateLimitCleared();
  const data = await dataPromise;
  assert.deepEqual(data, {});
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

// broadcastLifecycleUpdate

test("broadcastLifecycleUpdate: absent when no PR and not in planning set", async () => {
  const issue = makeIssue({ number: 5, title: "Fix bug" });
  const snapshot = { issues: [issue], pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ prPhase: string; pr: null }>;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.prPhase, "absent");
  assert.equal(pairs[0]!.pr, null);
});

test("broadcastLifecycleUpdate: all open issues appear regardless of project status", async () => {
  const snapshot = {
    issues: [
      makeIssue({ number: 1, projectStatus: "Backlog" }),
      makeIssue({ number: 2, projectStatus: "Ready" }),
      makeIssue({ number: 3, projectStatus: "In Progress" }),
      makeIssue({ number: 4, projectStatus: "In Review" }),
    ],
    pullRequests: [],
    agentSessions: [],
  };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set(), new Set(), {}, true);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } | null; prPhase: string; projectStatus?: string }>;
  // "Ready" issue sorts before "inactive" issues; inactive issues sort by number.
  assert.deepEqual(
    pairs.map((p) => p.issue?.number),
    [2, 1, 3, 4],
    "Ready issue should appear before inactive issues; all others sort by number",
  );
  assert.equal(pairs[0]!.prPhase, "absent", "Ready issue is absent (workable)");
  assert.equal(pairs[1]!.prPhase, "inactive");
  assert.equal(pairs[1]!.projectStatus, "Backlog");
  assert.equal(pairs[2]!.prPhase, "inactive");
  assert.equal(pairs[3]!.prPhase, "inactive");
});

test("broadcastLifecycleUpdate: planning when issue is in planningIssueNumbers", async () => {
  const issue = makeIssue({ number: 3 });
  const snapshot = { issues: [issue], pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set([3]));
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ prPhase: string }>;
  assert.equal(pairs[0]!.prPhase, "planning");
});

test("broadcastLifecycleUpdate: active when issue has a linked open draft PR", async () => {
  const issue = makeIssue({ number: 10 });
  const pr = makePR({ number: 20, closingIssueNumbers: [10], draft: true });
  const snapshot = { issues: [issue], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ prPhase: string; pr: { number: number } | null }>;
  assert.equal(pairs[0]!.prPhase, "active");
  assert.equal(pairs[0]!.pr?.number, 20);
});

test("broadcastLifecycleUpdate: review when issue has a linked open non-draft PR", async () => {
  const issue = makeIssue({ number: 11 });
  const pr = makePR({ number: 21, closingIssueNumbers: [11], draft: false });
  const snapshot = { issues: [issue], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ prPhase: string; pr: { number: number } | null }>;
  assert.equal(pairs[0]!.prPhase, "review");
  assert.equal(pairs[0]!.pr?.number, 21);
});

test("broadcastLifecycleUpdate: completed when issue is in completedIssueNumbers", async () => {
  const issue = makeIssue({ number: 7 });
  const pr = makePR({ number: 8, closingIssueNumbers: [7] });
  const snapshot = { issues: [issue], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set(), new Set([7]));
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ prPhase: string }>;
  assert.equal(pairs[0]!.prPhase, "completed");
});

test("broadcastLifecycleUpdate: falls back to linkedIssueNumbers when closingIssueNumbers is empty", async () => {
  const issue = makeIssue({ number: 4 });
  const pr = makePR({ number: 9, closingIssueNumbers: [], linkedIssueNumbers: [4], draft: false });
  const snapshot = { issues: [issue], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ prPhase: string; pr: { number: number } | null }>;
  assert.equal(pairs[0]!.prPhase, "review");
  assert.equal(pairs[0]!.pr?.number, 9);
});

test("broadcastLifecycleUpdate: pairs are sorted in ascending issue-number order", async () => {
  const issues = [makeIssue({ number: 30 }), makeIssue({ number: 5 }), makeIssue({ number: 17 })];
  const snapshot = { issues, pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } }>;
  assert.deepEqual(pairs.map((p) => p.issue.number), [5, 17, 30]);
});

test("broadcastLifecycleUpdate: pairs are sorted review→active→completed→planning→unblocked→blocked", async () => {
  const issues = [
    makeIssue({ number: 1 }), // blocked absent
    makeIssue({ number: 2 }), // unblocked absent
    makeIssue({ number: 3 }), // active (has open draft PR)
    makeIssue({ number: 4 }), // planning
    makeIssue({ number: 5 }), // completed
    makeIssue({ number: 6 }), // review (has open non-draft PR)
  ];
  const pr3 = makePR({ number: 103, closingIssueNumbers: [3], draft: true });
  const pr5 = makePR({ number: 105, closingIssueNumbers: [5] });
  const pr6 = makePR({ number: 106, closingIssueNumbers: [6], draft: false });
  const snapshot = { issues, pullRequests: [pr3, pr5, pr6], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(
    snapshot,
    new Set([4]),        // planning
    new Set([5]),        // completed
    { 1: [10] },         // #1 blocked by #10
  );
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number }; prPhase: string }>;
  assert.deepEqual(
    pairs.map((p) => p.issue.number),
    [6, 3, 5, 4, 2, 1],
    "order: review, active, completed, planning, unblocked absent, blocked absent",
  );
});

test("broadcastLifecycleUpdate: blocked absent issue has blockedByIssueNumbers populated", async () => {
  const issue = makeIssue({ number: 8 });
  const snapshot = { issues: [issue], pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set(), new Set(), { 8: [2, 5] });
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ blockedByIssueNumbers?: number[] }>;
  assert.deepEqual(pairs[0]!.blockedByIssueNumbers, [2, 5]);
});

test("broadcastLifecycleUpdate: unblocked absent issue has no blockedByIssueNumbers", async () => {
  const issue = makeIssue({ number: 9 });
  const snapshot = { issues: [issue], pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ blockedByIssueNumbers?: number[] }>;
  assert.equal(pairs[0]!.blockedByIssueNumbers, undefined);
});

test("broadcastLifecycleUpdate: within same phase group, sort by ascending issue number", async () => {
  const issues = [makeIssue({ number: 20 }), makeIssue({ number: 5 }), makeIssue({ number: 12 })];
  const snapshot = { issues, pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set(), new Set(), { 20: [1], 5: [1] });
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } }>;
  // #12 is unblocked (first), then #5 and #20 are blocked (ascending)
  assert.deepEqual(pairs.map((p) => p.issue.number), [12, 5, 20]);
});

test("broadcastLifecycleUpdate: colorIndex equals issue.number modulo 6", async () => {
  const issues = [makeIssue({ number: 6 }), makeIssue({ number: 7 }), makeIssue({ number: 13 })];
  const snapshot = { issues, pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number }; colorIndex: number }>;
  assert.equal(pairs.find((p) => p.issue.number === 6)!.colorIndex, 0);
  assert.equal(pairs.find((p) => p.issue.number === 7)!.colorIndex, 1);
  assert.equal(pairs.find((p) => p.issue.number === 13)!.colorIndex, 1);
});

// manual-label filtering — issues with the "manual" label must never appear
// in the dashboard (see issue #89).

test("broadcastLifecycleUpdate: excludes issues labelled 'manual'", async () => {
  const issues = [
    makeIssue({ number: 1, labels: ["manual"] }),
    makeIssue({ number: 2 }),
  ];
  const snapshot = { issues, pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } }>;
  assert.deepEqual(pairs.map((p) => p.issue.number), [2]);
});

test("broadcastLifecycleUpdate (focus mode): shows only issues labelled 'focus'", async () => {
  const issues = [
    makeIssue({ number: 1, labels: ["focus"] }),
    makeIssue({ number: 2 }),
    makeIssue({ number: 3, labels: ["focus", "bug"] }),
  ];
  const snapshot = { issues, pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set(), new Set(), {}, false, true);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } }>;
  assert.deepEqual(pairs.map((p) => p.issue.number), [1, 3]);
});

test("broadcastLifecycleUpdate (focus mode): drops a PR pair when its linked issue lacks 'focus'", async () => {
  const issues = [
    makeIssue({ number: 1, labels: ["focus"] }),
    makeIssue({ number: 2 }),
  ];
  const pullRequests = [
    makePR({ number: 10, closingIssueNumbers: [1], draft: false }),
    makePR({ number: 20, closingIssueNumbers: [2], draft: false }),
  ];
  const snapshot = { issues, pullRequests, agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set(), new Set(), {}, false, true);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } | null; pr: { number: number } | null }>;
  assert.deepEqual(pairs.map((p) => p.issue?.number), [1]);
  assert.deepEqual(pairs.map((p) => p.pr?.number), [10]);
});

test("broadcastLifecycleUpdate (focus mode): hides orphan PRs with no linked issue", async () => {
  const issues = [makeIssue({ number: 1, labels: ["focus"] })];
  const pullRequests = [
    makePR({ number: 30, closingIssueNumbers: [], linkedIssueNumbers: [], draft: false }),
  ];
  const snapshot = { issues, pullRequests, agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot, new Set(), new Set(), {}, false, true);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } | null }>;
  // Only the focus issue remains; the orphan PR is gone.
  assert.deepEqual(pairs.map((p) => p.issue?.number), [1]);
});

test("broadcastLifecycleUpdate: without focus mode, non-focus issues still appear", async () => {
  const issues = [
    makeIssue({ number: 1, labels: ["focus"] }),
    makeIssue({ number: 2 }),
  ];
  const snapshot = { issues, pullRequests: [], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } }>;
  assert.deepEqual(pairs.map((p) => p.issue.number), [1, 2]);
});

test("broadcastLifecycleUpdate: marks the pair disabled when the PR is labelled 'manual'", async () => {
  const issue = makeIssue({ number: 5 });
  const pr = makePR({ number: 50, closingIssueNumbers: [5], labels: ["manual"], draft: false });
  const snapshot = { issues: [issue], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{
    prPhase: string;
    disabled?: boolean;
    pr: { number: number } | null;
  }>;
  // The pair still appears, paired with its issue, but flagged disabled.
  assert.equal(pairs[0]!.pr?.number, 50);
  assert.equal(pairs[0]!.prPhase, "review");
  assert.equal(pairs[0]!.disabled, true);
});

test("broadcastLifecycleUpdate: a non-manual PR has no disabled flag", async () => {
  const issue = makeIssue({ number: 6 });
  const pr = makePR({ number: 60, closingIssueNumbers: [6] });
  const snapshot = { issues: [issue], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ disabled?: boolean }>;
  assert.equal(pairs[0]!.disabled, undefined);
});

test("broadcastLifecycleUpdate: drops PR pair when the linked issue is 'manual'", async () => {
  const issues = [makeIssue({ number: 3, labels: ["manual"] })];
  const pr = makePR({ number: 30, closingIssueNumbers: [3] });
  const snapshot = { issues, pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<unknown>;
  assert.equal(pairs.length, 0);
});

// orphan PRs — open PRs not connected to any issue appear as a whole pill
// with a null issue (the dashboard renders an empty left half).

test("broadcastLifecycleUpdate: open non-draft PR with no linked issue becomes an orphan pair with review phase", async () => {
  const pr = makePR({ number: 77, closingIssueNumbers: [], linkedIssueNumbers: [], draft: false });
  const snapshot = { issues: [], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{
    issue: unknown;
    pr: { number: number } | null;
    prPhase: string;
  }>;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.issue, null);
  assert.equal(pairs[0]!.pr?.number, 77);
  assert.equal(pairs[0]!.prPhase, "review");
});

test("broadcastLifecycleUpdate: open draft PR with no linked issue becomes an orphan pair with active phase", async () => {
  const pr = makePR({ number: 78, closingIssueNumbers: [], linkedIssueNumbers: [], draft: true });
  const snapshot = { issues: [], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{
    issue: unknown;
    pr: { number: number } | null;
    prPhase: string;
  }>;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.issue, null);
  assert.equal(pairs[0]!.pr?.number, 78);
  assert.equal(pairs[0]!.prPhase, "active");
});

test("broadcastLifecycleUpdate: closed PR with no linked issue is not shown", async () => {
  const pr = makePR({ number: 78, state: "closed", closingIssueNumbers: [], linkedIssueNumbers: [] });
  const snapshot = { issues: [], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<unknown>;
  assert.equal(pairs.length, 0);
});

test("broadcastLifecycleUpdate: a PR with a linked issue is never treated as orphan", async () => {
  const issue = makeIssue({ number: 4 });
  const pr = makePR({ number: 79, closingIssueNumbers: [], linkedIssueNumbers: [4] });
  const snapshot = { issues: [issue], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: { number: number } | null }>;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.issue?.number, 4);
});

test("broadcastLifecycleUpdate: a manual orphan PR is flagged disabled", async () => {
  const pr = makePR({ number: 80, closingIssueNumbers: [], linkedIssueNumbers: [], labels: ["manual"] });
  const snapshot = { issues: [], pullRequests: [pr], agentSessions: [] };
  const dataPromise = captureNextEvent("lifecycle-update");
  broadcastLifecycleUpdate(snapshot);
  const data = await dataPromise;
  const pairs = data.pairs as Array<{ issue: unknown; disabled?: boolean }>;
  assert.equal(pairs[0]!.issue, null);
  assert.equal(pairs[0]!.disabled, true);
});

test("broadcastIssueUpdate: emits nothing when the issue is labelled 'manual'", async () => {
  const issue = makeIssue({ number: 11, labels: ["manual"] });
  let emitted = false;
  const unsub = globalEventEmitter.subscribe((event: DashboardEvent) => {
    if (event.type === "broadcast-issue-update") emitted = true;
  });
  broadcastIssueUpdate(issue, "opened");
  // Give the emitter a tick to flush any synchronous listeners.
  await new Promise((resolve) => setImmediate(resolve));
  unsub();
  assert.equal(emitted, false);
});

test("broadcastRepositorySnapshot: open-issue count excludes 'manual'-labelled issues", async () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      makeIssue({ number: 1, labels: ["manual"] }),
      makeIssue({ number: 2 }),
      makeIssue({ number: 3 }),
    ],
    pullRequests: [],
    agentSessions: [],
  };
  const dataPromise = captureNextEvent("broadcast-github-activity");
  broadcastRepositorySnapshot(snapshot, "owner", "repo");
  const data = await dataPromise;
  assert.equal(data.issueCount, 2);
  assert.ok((data.content as string).includes("2 open issues"));
  assert.ok((data.stateAfter as string).startsWith("2 issues open"));
});

// hasPrStateChanged

test("hasPrStateChanged: returns false when all fields are identical", () => {
  const pr = makePR();
  assert.equal(hasPrStateChanged(pr, pr), false);
});

test("hasPrStateChanged: detects state transition", () => {
  const current = makePR({ state: "closed" });
  const last = makePR({ state: "open" });
  assert.equal(hasPrStateChanged(current, last), true);
});

test("hasPrStateChanged: detects draft change", () => {
  const current = makePR({ draft: false });
  const last = makePR({ draft: true });
  assert.equal(hasPrStateChanged(current, last), true);
});

test("hasPrStateChanged: detects checksStatus change", () => {
  const current = makePR({ checksStatus: "success" });
  const last = makePR({ checksStatus: "pending" });
  assert.equal(hasPrStateChanged(current, last), true);
});

test("hasPrStateChanged: detects unresolvedReviewCommentCount change", () => {
  const current = makePR({ unresolvedReviewCommentCount: 3 });
  const last = makePR({ unresolvedReviewCommentCount: 0 });
  assert.equal(hasPrStateChanged(current, last), true);
});

test("hasPrStateChanged: detects hasMergeConflicts change", () => {
  const current = makePR({ hasMergeConflicts: true });
  const last = makePR({ hasMergeConflicts: false });
  assert.equal(hasPrStateChanged(current, last), true);
});

// filterNewCommits

function makeCommit(hash: string): import("../src/types.js").Commit {
  return { hash, author: "dev", message: "msg", pushedAt: new Date().toISOString() };
}

test("filterNewCommits: returns all commits when seenHashes is empty", () => {
  const commits = [makeCommit("aaa"), makeCommit("bbb")];
  assert.deepEqual(filterNewCommits(commits, new Set()), commits);
});

test("filterNewCommits: excludes commits whose hash is already seen", () => {
  const commits = [makeCommit("aaa"), makeCommit("bbb"), makeCommit("ccc")];
  const result = filterNewCommits(commits, new Set(["aaa", "ccc"]));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.hash, "bbb");
});

test("filterNewCommits: returns empty array when all commits are seen", () => {
  const commits = [makeCommit("aaa"), makeCommit("bbb")];
  assert.deepEqual(filterNewCommits(commits, new Set(["aaa", "bbb"])), []);
});
