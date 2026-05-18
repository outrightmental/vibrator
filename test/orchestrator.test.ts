import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMergedPullRequestBody,
  buildBlockedIssueIndex,
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
    ...(overrides.parentNumber !== undefined ? { parentNumber: overrides.parentNumber } : {}),
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
    headCommitPushedAt: overrides.headCommitPushedAt,
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
      type: "self-review",
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

test("buildPlan self-reviews a PR with no linked issue", () => {
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [createPullRequest({ number: 200, linkedIssueNumbers: [] })],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "self-review",
      issueNumber: undefined,
      pullRequestNumber: 200,
      pullRequestHeadSha: "sha-200",
    },
  ]);
});

test("buildPlan runs a second self-review after the first one made changes", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [createPullRequest({ number: 16, linkedIssueNumbers: [7] })],
    agentSessions: [
      createSession({
        id: "self-review-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "self-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { madeChanges: true, pullRequestHeadSha: "sha-16" },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "self-review",
      issueNumber: 7,
      pullRequestNumber: 16,
      pullRequestHeadSha: "sha-16",
    },
  ]);
});

test("buildPlan runs a second self-review after the first clean pass", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [createPullRequest({ number: 16, linkedIssueNumbers: [7] })],
    agentSessions: [
      createSession({
        id: "self-review-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "self-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { madeChanges: false, pullRequestHeadSha: "sha-16" },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "self-review",
      issueNumber: 7,
      pullRequestNumber: 16,
      pullRequestHeadSha: "sha-16",
    },
  ]);
});

test("buildPlan squash-merges after two consecutive clean self-reviews", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [
      createPullRequest({
        number: 16,
        linkedIssueNumbers: [7],
        closingIssueNumbers: [7],
        headRefName: "branch-16",
      }),
    ],
    agentSessions: [
      createSession({
        id: "self-review-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "self-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { madeChanges: false },
      }),
      createSession({
        id: "self-review-2",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "self-review",
        updatedAt: "2024-01-03T00:00:00.000Z",
        result: { madeChanges: false },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "squash-merge",
      issueNumber: 7,
      pullRequestNumber: 16,
      pullRequestTitle: "PR 16",
      pullRequestHeadRefName: "branch-16",
      closingIssueNumbers: [7],
      pullRequestBody: "",
    },
  ]);
});

test("buildPlan does not squash-merge when two clean reviews are separated by a changes-making review", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [createPullRequest({ number: 16, linkedIssueNumbers: [7] })],
    agentSessions: [
      createSession({
        id: "self-review-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "self-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { madeChanges: false },
      }),
      createSession({
        id: "self-review-2",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "self-review",
        updatedAt: "2024-01-03T00:00:00.000Z",
        result: { madeChanges: true },
      }),
      createSession({
        id: "self-review-3",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "self-review",
        updatedAt: "2024-01-04T00:00:00.000Z",
        result: { madeChanges: false },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  // The penultimate session made changes, so one more clean pass is needed.
  assert.deepEqual(plan.actions, [
    {
      type: "self-review",
      issueNumber: 7,
      pullRequestNumber: 16,
      pullRequestHeadSha: "sha-16",
    },
  ]);
});

test("buildPlan requests a fresh self-review after conflicts are resolved", () => {
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
      type: "self-review",
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

test("buildPlan emits no action after squash-merge session has completed", () => {
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
        id: "merge-done",
        issueNumber: 5,
        pullRequestNumber: 15,
        phase: "squash-merge",
        updatedAt: "2024-01-03T00:00:00.000Z",
        result: { pullRequestBody: "Final summary." },
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
        id: "active-self-review",
        issueNumber: 3,
        pullRequestNumber: 20,
        phase: "self-review",
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
      }),
    ],
    agentSessions: [
      createSession({
        id: "self-review-8",
        issueNumber: 8,
        pullRequestNumber: 20,
        phase: "self-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { madeChanges: true },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "self-review",
      issueNumber: 8,
      pullRequestNumber: 20,
      pullRequestHeadSha: "sha-20",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Parent / child blocking
// ---------------------------------------------------------------------------

test("buildBlockedIssueIndex marks parent as blocked by each open child", () => {
  const issues = [
    createIssue({ number: 10 }),                        // parent (D)
    createIssue({ number: 1, parentNumber: 10 }),       // child A
    createIssue({ number: 2, parentNumber: 10 }),       // child B
    createIssue({ number: 3, parentNumber: 10 }),       // child C
  ];

  const index = buildBlockedIssueIndex(issues);

  // Issue 10 (D) is blocked by all three children.
  assert.deepEqual(index[10], [1, 2, 3]);
  // Children themselves carry no blockers from this relationship.
  assert.equal(index[1], undefined);
  assert.equal(index[2], undefined);
  assert.equal(index[3], undefined);
});

test("buildPlan does not start a parent issue that has open children", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 10, createdAt: "2024-01-01T00:00:00.000Z" }), // parent D
      createIssue({ number: 1, createdAt: "2024-01-02T00:00:00.000Z", parentNumber: 10 }), // child A
      createIssue({ number: 2, createdAt: "2024-01-03T00:00:00.000Z", parentNumber: 10 }), // child B
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  // Children can be started; parent (10) must not be started while children are open.
  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 1 },
    { type: "start-implementation", issueNumber: 2 },
  ]);
  assert.ok(
    !plan.actions.some((a) => a.type === "start-implementation" && a.issueNumber === 10),
    "Parent issue 10 must not be started while children are open",
  );
});

test("buildPlan can start a parent issue once all its children are closed", () => {
  // Only the parent is in the open issues list; children have been closed.
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 10 }), // parent D — children are closed, not in list
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 10 },
  ]);
});

test("buildPlan blockedIssueNumbers includes parent entries from child relationship", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 10 }),                       // parent
      createIssue({ number: 1, parentNumber: 10 }),      // child
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.blockedIssueNumbers[10], [1]);
});

test("buildPlan never starts a blocked issue (text-based blocking regression check)", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, createdAt: "2024-01-01T00:00:00.000Z" }),
      createIssue({
        number: 2,
        createdAt: "2024-01-02T00:00:00.000Z",
        body: "blocked by #1",
      }),
      createIssue({
        number: 3,
        createdAt: "2024-01-03T00:00:00.000Z",
        body: "depends on #1",
      }),
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  // Only issue 1 is eligible; 2 and 3 are blocked by it.
  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 1 },
  ]);
  assert.ok(
    !plan.actions.some((a) => a.type === "start-implementation" && a.issueNumber === 2),
    "Issue 2 must not start while blocked by #1",
  );
  assert.ok(
    !plan.actions.some((a) => a.type === "start-implementation" && a.issueNumber === 3),
    "Issue 3 must not start while blocked by #1",
  );
});
