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
    assignees: overrides.assignees ?? [],
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
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    hasMergeConflicts: overrides.hasMergeConflicts ?? false,
    hasCleanCopilotReviewOnHead: overrides.hasCleanCopilotReviewOnHead ?? false,
    copilotLastAgentRunFailed: overrides.copilotLastAgentRunFailed ?? false,
    changedFiles: overrides.changedFiles ?? 1,
    checksStatus: overrides.checksStatus ?? "success",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    linkedIssueNumbers: overrides.linkedIssueNumbers,
    closingIssueNumbers: overrides.closingIssueNumbers ?? overrides.linkedIssueNumbers,
  };
}

function createSession(overrides: Partial<AgentSession> & Pick<AgentSession, "id" | "issueNumber" | "phase">): AgentSession {
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
  if (overrides.staleReason !== undefined) {
    session.staleReason = overrides.staleReason;
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
    { type: "request-review", issueNumber: 3, pullRequestNumber: 10 },
    { type: "start-implementation", issueNumber: 1 },
    { type: "start-implementation", issueNumber: 4 },
  ]);
});

test("buildPlan prioritizes bug-typed issues ahead of older non-bug issues", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      // Older feature issue — would win on createdAt alone.
      createIssue({ number: 9, createdAt: "2024-01-01T00:00:00.000Z", type: "Feature" }),
      createIssue({ number: 50, createdAt: "2024-02-01T00:00:00.000Z", type: "Task" }),
      // Newer bug — must be picked first by virtue of its issue Type.
      createIssue({ number: 70, createdAt: "2024-03-01T00:00:00.000Z", type: "Bug" }),
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 1);

  assert.deepEqual(plan.actions, [{ type: "start-implementation", issueNumber: 70 }]);
});

test("buildPlan shepherds a PR with no linked issue by requesting Copilot review", () => {
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [createPullRequest({ number: 200, linkedIssueNumbers: [] })],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: undefined, pullRequestNumber: 200 },
  ]);
});

test("buildPlan continues shepherding an unlinked PR through the review cycle", () => {
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 201,
        linkedIssueNumbers: [],
        hasCleanCopilotReviewOnHead: true,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "write-final-description",
      issueNumber: undefined,
      pullRequestNumber: 201,
      pullRequestTitle: "PR 201",
      pullRequestHeadRefName: "branch-201",
      closingIssueNumbers: [],
      pullRequestBody: "",
    },
  ]);
});

test("buildPlan requests another review after review comments are addressed", () => {  const snapshot: RepositorySnapshot = {
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
      type: "request-review",
      issueNumber: 9,
      pullRequestNumber: 12,
      resolveReviewThreads: true,
    },
  ]);
});

test("buildPlan does not re-request review when Copilot has cleanly reviewed the current head", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 91 })],
    pullRequests: [
      createPullRequest({
        number: 191,
        linkedIssueNumbers: [91],
        hasCleanCopilotReviewOnHead: true,
      }),
    ],
    agentSessions: [
      createSession({
        id: "address-1",
        issueNumber: 91,
        pullRequestNumber: 191,
        phase: "address-review-comments",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "write-final-description",
      issueNumber: 91,
      pullRequestNumber: 191,
      pullRequestTitle: "PR 191",
      pullRequestHeadRefName: "branch-191",
      closingIssueNumbers: [91],
      pullRequestBody: "",
    },
  ]);
});

test("buildPlan jumps straight to final-description when a clean Copilot review is seen with no prior session", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 92 })],
    pullRequests: [
      createPullRequest({
        number: 192,
        linkedIssueNumbers: [92],
        hasCleanCopilotReviewOnHead: true,
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
    pullRequests: [createPullRequest({ number: 16, linkedIssueNumbers: [7] })],
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
      reviewCommentCount: 2,
    },
  ]);
});

test("buildPlan merges a pull request after a final description has been generated", () => {
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
        result: { generatedDescription: "Final summary." },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "merge-pull-request",
      issueNumber: 5,
      closingIssueNumbers: [5],
      pullRequestNumber: 15,
      pullRequestBody: "Final summary.\n\nCloses #5",
    },
  ]);
});

test("buildPlan requests Copilot review on a draft pull request with no prior session", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 11 })],
    pullRequests: [
      createPullRequest({
        number: 21,
        linkedIssueNumbers: [11],
        draft: true,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 11, pullRequestNumber: 21 },
  ]);
});

test("buildPlan asks Copilot to resolve merge conflicts before any other PR action", () => {
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

test("buildPlan asks Copilot to resolve conflicts even when a completed session exists", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 13 })],
    pullRequests: [
      createPullRequest({
        number: 23,
        linkedIssueNumbers: [13],
        hasMergeConflicts: true,
        headSha: "sha-conflict-2",
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-1",
        issueNumber: 13,
        pullRequestNumber: 23,
        phase: "review",
        result: { reviewCommentCount: 0 },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "resolve-conflicts",
      issueNumber: 13,
      pullRequestNumber: 23,
      pullRequestHeadSha: "sha-conflict-2",
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
    { type: "request-review", issueNumber: 14, pullRequestNumber: 24 },
  ]);
});

test("buildPlan does not merge a draft pull request after final description completion", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 5 })],
    pullRequests: [
      createPullRequest({
        number: 15,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        body: "Ready to merge.",
        draft: true,
      }),
    ],
    agentSessions: [
      createSession({
        id: "description-draft-1",
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

test("buildPlan does not append closing references for non-closing issue links", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 6 })],
    pullRequests: [
      createPullRequest({
        number: 18,
        linkedIssueNumbers: [6],
        closingIssueNumbers: [],
        body: "Implements the requested change for #6.",
      }),
    ],
    agentSessions: [
      createSession({
        id: "description-2",
        issueNumber: 6,
        pullRequestNumber: 18,
        phase: "final-description",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { generatedDescription: "Final summary." },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "merge-pull-request",
      issueNumber: 6,
      closingIssueNumbers: [],
      pullRequestNumber: 18,
      pullRequestBody: "Final summary.",
    },
  ]);
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

test("buildPlan uses sessions from any linked issue on the same pull request", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 3 }), createIssue({ number: 8 })],
    pullRequests: [createPullRequest({ number: 20, linkedIssueNumbers: [3, 8] })],
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
      reviewCommentCount: 1,
    },
  ]);
});

test("buildPlan resets PR draft state and re-requests review after a failed Copilot review", () => {
  // Regression test for the "Copilot wasn't able to review any files in
  // this pull request." failure mode. When reconcile marks a review
  // session as failed, the next review request must include
  // resetDraftState so the PR is toggled draft → ready-for-review before
  // Copilot is re-asked to review — otherwise Copilot tends to ignore the
  // new request and the orchestrator loops indefinitely.
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 96 })],
    pullRequests: [
      createPullRequest({
        number: 196,
        linkedIssueNumbers: [96],
      }),
    ],
    agentSessions: [
      createSession({
        id: "implementation-1",
        issueNumber: 96,
        pullRequestNumber: 196,
        phase: "implementation",
        status: "completed",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
      createSession({
        id: "review-failed-1",
        issueNumber: 96,
        pullRequestNumber: 196,
        phase: "review",
        status: "failed",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "request-review",
      issueNumber: 96,
      pullRequestNumber: 196,
      resetDraftState: true,
    },
  ]);
});

test("buildPlan does not reset PR draft state when the most recent review succeeded", () => {
  // A previously-failed review should not trigger a reset once a later
  // review session completed successfully on the same PR.
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 96 })],
    pullRequests: [
      createPullRequest({
        number: 196,
        linkedIssueNumbers: [96],
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-failed-1",
        issueNumber: 96,
        pullRequestNumber: 196,
        phase: "review",
        status: "failed",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
      createSession({
        id: "address-1",
        issueNumber: 96,
        pullRequestNumber: 196,
        phase: "address-review-comments",
        status: "completed",
        updatedAt: "2024-01-03T00:00:00.000Z",
      }),
      createSession({
        id: "review-ok-1",
        issueNumber: 96,
        pullRequestNumber: 196,
        phase: "review",
        status: "completed",
        updatedAt: "2024-01-04T00:00:00.000Z",
        result: { reviewCommentCount: 0 },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  // Latest completed session is the successful review — advance to final
  // description, no resetDraftState flag involved.
  assert.deepEqual(plan.actions, [
    {
      type: "write-final-description",
      issueNumber: 96,
      pullRequestNumber: 196,
      pullRequestTitle: "PR 196",
      pullRequestHeadRefName: "branch-196",
      closingIssueNumbers: [96],
      pullRequestBody: "",
    },
  ]);
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

test("buildPlan sets reassignCopilot on address-review-comments after a copilot-did-not-acknowledge failure", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [createPullRequest({ number: 16, linkedIssueNumbers: [7] })],
    agentSessions: [
      createSession({
        id: "review-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "review",
        status: "completed",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { reviewCommentCount: 2 },
      }),
      createSession({
        id: "address-failed-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "address-review-comments",
        status: "failed",
        updatedAt: "2024-01-02T00:30:00.000Z",
        staleReason: "copilot-did-not-acknowledge",
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
      reviewCommentCount: 2,
      reassignCopilot: true,
    },
  ]);
});

test("buildPlan does not set reassignCopilot when a later completed address-review-comments session cleared the no-ack failure", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7 })],
    pullRequests: [createPullRequest({ number: 16, linkedIssueNumbers: [7] })],
    agentSessions: [
      createSession({
        id: "review-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "review",
        status: "completed",
        updatedAt: "2024-01-03T00:00:00.000Z",
        result: { reviewCommentCount: 1 },
      }),
      createSession({
        id: "address-failed-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "address-review-comments",
        status: "failed",
        updatedAt: "2024-01-02T00:30:00.000Z",
        staleReason: "copilot-did-not-acknowledge",
      }),
      createSession({
        id: "address-completed-1",
        issueNumber: 7,
        pullRequestNumber: 16,
        phase: "address-review-comments",
        status: "completed",
        updatedAt: "2024-01-02T01:00:00.000Z",
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
      reviewCommentCount: 1,
    },
  ]);
});

test("buildPlan sets reassignCopilot on start-implementation after a copilot-did-not-acknowledge implementation failure", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 42, createdAt: "2024-01-01T00:00:00.000Z" })],
    pullRequests: [],
    agentSessions: [
      createSession({
        id: "impl-failed-1",
        issueNumber: 42,
        phase: "implementation",
        status: "failed",
        updatedAt: "2024-01-02T00:30:00.000Z",
        staleReason: "copilot-did-not-acknowledge",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 2);

  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 42, reassignCopilot: true },
  ]);
});

test("buildPlan skips PRs whose title is still prefixed with [WIP]", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 5 })],
    pullRequests: [
      createPullRequest({
        number: 11,
        title: "[WIP] add new endpoint",
        linkedIssueNumbers: [5],
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-1",
        issueNumber: 5,
        pullRequestNumber: 11,
        phase: "review",
        status: "completed",
        result: { reviewCommentCount: 0 },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  // No action at all for the WIP PR; the linked issue is also covered by
  // the PR so no start-implementation for it either.
  assert.deepEqual(
    plan.actions.filter((a) => "pullRequestNumber" in a && a.pullRequestNumber === 11),
    [],
  );
  assert.deepEqual(
    plan.actions.filter((a) => a.type === "start-implementation" && a.issueNumber === 5),
    [],
  );
});

test("buildPlan recovers a [WIP] PR by re-assigning Copilot when its last agent run failed", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 42 })],
    pullRequests: [
      createPullRequest({
        number: 117,
        title: "[WIP] Add email report delivery with magic link",
        linkedIssueNumbers: [42],
        copilotLastAgentRunFailed: true,
        // Some file changes already exist — Copilot got partway through
        // before crashing. The recovery is to re-assign to the issue
        // (Copilot picks the existing branch back up).
        changedFiles: 3,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 42, reassignCopilot: true },
  ]);
});

test("buildPlan abandons an empty [WIP] PR (0 changedFiles) when its last agent run failed", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 42 })],
    pullRequests: [
      createPullRequest({
        number: 117,
        title: "[WIP] Add email report delivery with magic link",
        linkedIssueNumbers: [42],
        copilotLastAgentRunFailed: true,
        changedFiles: 0,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "abandon-empty-pull-request",
      issueNumber: 42,
      pullRequestNumber: 117,
    },
  ]);
});

test("buildPlan does not recover a [WIP] PR with no linked issue", () => {
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 119,
        title: "[WIP] orphan PR",
        linkedIssueNumbers: [],
        copilotLastAgentRunFailed: true,
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, []);
});


test("buildPlan skips PRs whose title starts with wip: (lowercase, colon form)", () => {
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 12,
        title: "wip: still iterating",
        linkedIssueNumbers: [],
        closingIssueNumbers: [],
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, []);
});

test("buildPlan does not skip PRs whose title merely contains the substring 'wip' later", () => {
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 13,
        title: "Add swiping UI",
        linkedIssueNumbers: [],
        closingIssueNumbers: [],
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: undefined, pullRequestNumber: 13 },
  ]);
});

test("buildPlan asks Copilot to address failing checks before merging on a clean Copilot review", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 401 })],
    pullRequests: [
      createPullRequest({
        number: 501,
        linkedIssueNumbers: [401],
        hasCleanCopilotReviewOnHead: true,
        checksStatus: "failure",
        headSha: "sha-501-failing",
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "address-failing-checks",
      issueNumber: 401,
      pullRequestNumber: 501,
      pullRequestHeadSha: "sha-501-failing",
    },
  ]);
});

test("buildPlan asks Copilot to address failing checks after a clean review session completes", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 402 })],
    pullRequests: [
      createPullRequest({
        number: 502,
        linkedIssueNumbers: [402],
        checksStatus: "failure",
        headSha: "sha-502-failing",
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-502",
        issueNumber: 402,
        pullRequestNumber: 502,
        phase: "review",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { reviewCommentCount: 0 },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "address-failing-checks",
      issueNumber: 402,
      pullRequestNumber: 502,
      pullRequestHeadSha: "sha-502-failing",
    },
  ]);
});

test("buildPlan waits silently when checks are still pending before merge", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 403 })],
    pullRequests: [
      createPullRequest({
        number: 503,
        linkedIssueNumbers: [403],
        hasCleanCopilotReviewOnHead: true,
        checksStatus: "pending",
      }),
    ],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, []);
});

test("buildPlan blocks merge-pull-request when checks have failed after final description", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 404 })],
    pullRequests: [
      createPullRequest({
        number: 504,
        linkedIssueNumbers: [404],
        closingIssueNumbers: [404],
        checksStatus: "failure",
        headSha: "sha-504-failing",
      }),
    ],
    agentSessions: [
      createSession({
        id: "description-504",
        issueNumber: 404,
        pullRequestNumber: 504,
        phase: "final-description",
        updatedAt: "2024-01-02T00:00:00.000Z",
        result: { generatedDescription: "All done." },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    {
      type: "address-failing-checks",
      issueNumber: 404,
      pullRequestNumber: 504,
      pullRequestHeadSha: "sha-504-failing",
    },
  ]);
});

test("buildPlan requests a fresh review after failing checks have been addressed", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 405 })],
    pullRequests: [
      createPullRequest({
        number: 505,
        linkedIssueNumbers: [405],
        checksStatus: "success",
      }),
    ],
    agentSessions: [
      createSession({
        id: "address-checks-505",
        issueNumber: 405,
        pullRequestNumber: 505,
        phase: "address-failing-checks",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 405, pullRequestNumber: 505 },
  ]);
});

