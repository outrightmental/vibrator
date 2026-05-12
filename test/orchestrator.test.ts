import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMergedPullRequestBody,
  buildPlan,
  parseClosingIssueNumbers,
  parseLinkedIssueNumbers,
} from "../src/orchestrator.js";
import type { AgentSession, Issue, PullRequest, RepositorySnapshot } from "../src/types.js";

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

function createPullRequest(
  overrides: Partial<PullRequest> & Pick<PullRequest, "number" | "linkedIssueNumbers">,
): PullRequest {
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
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    linkedIssueNumbers: overrides.linkedIssueNumbers,
    closingIssueNumbers: overrides.closingIssueNumbers ?? overrides.linkedIssueNumbers,
  };
}

function createSession(
  overrides: Partial<AgentSession> & Pick<AgentSession, "id" | "issueNumber" | "phase">,
): AgentSession {
  const session: AgentSession = {
    id: overrides.id,
    issueNumber: overrides.issueNumber,
    phase: overrides.phase,
    status: overrides.status ?? "completed",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
  };
  if (overrides.completedAt !== undefined) {
    session.completedAt = overrides.completedAt;
  }
  if (overrides.pullRequestNumber !== undefined) {
    session.pullRequestNumber = overrides.pullRequestNumber;
  }
  if (overrides.result !== undefined) {
    session.result = overrides.result;
  }
  return session;
}

test("buildPlan chooses the oldest unblocked issues up to available capacity", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, createdAt: "2024-01-01T00:00:00.000Z" }),
      createIssue({
        number: 2,
        createdAt: "2024-01-02T00:00:00.000Z",
        body: "blocked by #1",
      }),
      createIssue({ number: 3, createdAt: "2024-01-03T00:00:00.000Z" }),
      createIssue({ number: 4, createdAt: "2024-01-04T00:00:00.000Z" }),
    ],
    pullRequests: [createPullRequest({ number: 10, linkedIssueNumbers: [3] })],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "review-pull-request",
      issueNumber: 3,
      pullRequestNumber: 10,
      pullRequestHeadSha: "sha-10",
    },
    { type: "start-implementation", issueNumber: 1 },
    { type: "start-implementation", issueNumber: 4 },
  ]);
});

test("buildPlan prioritizes bug-typed issues ahead of older non-bug issues", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 9, createdAt: "2024-01-01T00:00:00.000Z", type: "Feature" }),
      createIssue({ number: 50, createdAt: "2024-02-01T00:00:00.000Z", type: "Task" }),
      createIssue({ number: 70, createdAt: "2024-03-01T00:00:00.000Z", type: "Bug" }),
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 1);

  assert.deepEqual(plan.actions, [{ type: "start-implementation", issueNumber: 70 }]);
});

test("buildPlan shepherds a PR with no linked issue by requesting a Claude review", () => {
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [createPullRequest({ number: 200, linkedIssueNumbers: [] })],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "review-pull-request",
      issueNumber: undefined,
      pullRequestNumber: 200,
      pullRequestHeadSha: "sha-200",
    },
  ]);
});

test("buildPlan jumps straight to final-description when a clean review is seen with no prior session", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 92 })],
    pullRequests: [
      createPullRequest({
        number: 192,
        linkedIssueNumbers: [92],
        hasCleanReviewOnHead: true,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "write-final-description",
      issueNumber: 92,
      pullRequestNumber: 192,
      pullRequestTitle: "PR 192",
      pullRequestHeadRefName: "branch-192",
      closingIssueNumbers: [92],
      pullRequestBody: "",
    },
  ]);
});

test("buildPlan asks for review comment fixes when the latest review found issues", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [
      createPullRequest({
        number: 16,
        linkedIssueNumbers: [7],
        unresolvedReviewCommentCount: 2,
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { reviewCommentCount: 2 },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "address-review-comments",
      issueNumber: 7,
      pullRequestNumber: 16,
      pullRequestHeadSha: "sha-16",
      unresolvedReviewCommentCount: 2,
    },
  ]);
});

test("buildPlan advances to final-description after a clean (zero-comment) review", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [
      createPullRequest({
        number: 16,
        linkedIssueNumbers: [7],
        hasCleanReviewOnHead: true,
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-clean",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { reviewCommentCount: 0 },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "write-final-description",
      issueNumber: 7,
      pullRequestNumber: 16,
      pullRequestTitle: "PR 16",
      pullRequestHeadRefName: "branch-16",
      closingIssueNumbers: [7],
      pullRequestBody: "",
    },
  ]);
});

test("buildPlan requests another review after review comments are addressed", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 9 })],
    pullRequests: [createPullRequest({ number: 12, linkedIssueNumbers: [9] })],
    agentSessions: [
      createSession({
        id: "address-1",
        issueNumber: 9,
        pullRequestNumber: 12,
        phase: "address-review-comments",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "review-pull-request",
      issueNumber: 9,
      pullRequestNumber: 12,
      pullRequestHeadSha: "sha-12",
    },
  ]);
});

test("buildPlan requests a fresh review after conflicts are resolved", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 14 })],
    pullRequests: [
      createPullRequest({
        number: 24,
        linkedIssueNumbers: [14],
        hasMergeConflicts: false,
      }),
    ],
    agentSessions: [
      createSession({
        id: "resolve-conflicts-1",
        issueNumber: 14,
        pullRequestNumber: 24,
        phase: "resolve-conflicts",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "review-pull-request",
      issueNumber: 14,
      pullRequestNumber: 24,
      pullRequestHeadSha: "sha-24",
    },
  ]);
});

test("buildPlan asks Claude to resolve merge conflicts before any other PR action", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 12 })],
    pullRequests: [
      createPullRequest({
        number: 22,
        linkedIssueNumbers: [12],
        hasMergeConflicts: true,
        headSha: "sha-conflict",
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "resolve-conflicts",
      issueNumber: 12,
      pullRequestNumber: 22,
      pullRequestHeadSha: "sha-conflict",
    },
  ]);
});

test("buildPlan asks Claude to fix failing checks before merging", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 12 })],
    pullRequests: [
      createPullRequest({
        number: 22,
        linkedIssueNumbers: [12],
        checksStatus: "failure",
        hasCleanReviewOnHead: true,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "address-failing-checks",
      issueNumber: 12,
      pullRequestNumber: 22,
      pullRequestHeadSha: "sha-22",
    },
  ]);
});

test("buildPlan emits no action while checks are pending", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 12 })],
    pullRequests: [
      createPullRequest({
        number: 22,
        linkedIssueNumbers: [12],
        checksStatus: "pending",
        hasCleanReviewOnHead: true,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, []);
});

test("buildPlan re-requests the final description if none was captured", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 5 })],
    pullRequests: [
      createPullRequest({
        number: 15,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        body: "Ready to merge.",
      }),
    ],
    agentSessions: [
      createSession({
        id: "description-1",
        issueNumber: 5,
        pullRequestNumber: 15,
        phase: "final-description",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "write-final-description",
      issueNumber: 5,
      pullRequestNumber: 15,
      pullRequestTitle: "PR 15",
      pullRequestHeadRefName: "branch-15",
      closingIssueNumbers: [5],
      pullRequestBody: "Ready to merge.",
    },
  ]);
});

test("buildPlan emits no action after the final description session has completed (merge already done)", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 5 })],
    pullRequests: [
      createPullRequest({
        number: 15,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
      }),
    ],
    agentSessions: [
      createSession({
        id: "description-done",
        issueNumber: 5,
        pullRequestNumber: 15,
        phase: "final-description",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { generatedDescription: "Final summary." },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, []);
});

test("parseLinkedIssueNumbers finds closes and fixes references", () => {
  assert.deepEqual(
    parseLinkedIssueNumbers("Implements feature. Fixes #12 and closes #7."),
    [7, 12],
  );
});

test("parseClosingIssueNumbers only finds explicit closing references", () => {
  assert.deepEqual(
    parseClosingIssueNumbers("For #12. Implements #8. Fixes #7 and closes: #3."),
    [3, 7],
  );
});

test("parseLinkedIssueNumbers accepts optional punctuation before the issue reference", () => {
  assert.deepEqual(
    parseLinkedIssueNumbers("Closes: #12\nFixes:#7\nResolves : #9"),
    [7, 9, 12],
  );
});

test("buildMergedPullRequestBody appends a closing reference once", () => {
  assert.equal(
    buildMergedPullRequestBody("Summary", [42]),
    "Summary\n\nCloses #42",
  );
  assert.equal(
    buildMergedPullRequestBody("Summary\n\nCloses #42", [42]),
    "Summary\n\nCloses #42",
  );
  assert.equal(
    buildMergedPullRequestBody("Summary\n\ncloses #42", [42]),
    "Summary\n\ncloses #42",
  );
  assert.equal(
    buildMergedPullRequestBody("Summary", [42, 7]),
    "Summary\n\nCloses #7\n\nCloses #42",
  );
});

test("buildPlan does not reduce capacity for implementation sessions on closed issues", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, createdAt: "2024-01-01T00:00:00.000Z" }),
      createIssue({ number: 2, createdAt: "2024-01-02T00:00:00.000Z" }),
    ],
    pullRequests: [],
    agentSessions: [
      createSession({
        id: "implementation-closed",
        issueNumber: 99,
        phase: "implementation",
        status: "in_progress",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 2);

  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 1 },
    { type: "start-implementation", issueNumber: 2 },
  ]);
});

test("buildPlan suppresses planning for PRs with an active session", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 3 })],
    pullRequests: [createPullRequest({ number: 20, linkedIssueNumbers: [3] })],
    agentSessions: [
      createSession({
        id: "active-review",
        issueNumber: 3,
        pullRequestNumber: 20,
        phase: "review",
        status: "in_progress",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, []);
});

test("buildPlan uses sessions from any linked issue on the same pull request", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 3 }), createIssue({ number: 8 })],
    pullRequests: [
      createPullRequest({
        number: 20,
        linkedIssueNumbers: [3, 8],
        unresolvedReviewCommentCount: 1,
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-8",
        issueNumber: 8,
        pullRequestNumber: 20,
        phase: "review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { reviewCommentCount: 1 },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "address-review-comments",
      issueNumber: 8,
      pullRequestNumber: 20,
      pullRequestHeadSha: "sha-20",
      unresolvedReviewCommentCount: 1,
    },
  ]);
});
