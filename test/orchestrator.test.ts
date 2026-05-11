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
  };
}

function createPullRequest(
  overrides: Partial<PullRequest> & Pick<PullRequest, "number" | "linkedIssueNumbers">,
): PullRequest {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    body: overrides.body ?? "",
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
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
      type: "request-review",
      issueNumber: 9,
      pullRequestNumber: 12,
      resolveReviewThreads: true,
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
      closingIssueNumbers: [5],
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
      reviewCommentCount: 1,
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
