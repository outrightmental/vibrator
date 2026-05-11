import test from "node:test";
import assert from "node:assert/strict";

import { reconcileSessions } from "../src/reconcile.js";
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
  };
}

function createPullRequest(
  overrides: Partial<PullRequest> &
    Pick<PullRequest, "number" | "linkedIssueNumbers" | "closingIssueNumbers">,
): PullRequest {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    body: overrides.body ?? "",
    headSha: overrides.headSha ?? `sha-${overrides.number}`,
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    hasMergeConflicts: overrides.hasMergeConflicts ?? false,
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    linkedIssueNumbers: overrides.linkedIssueNumbers,
    closingIssueNumbers: overrides.closingIssueNumbers,
  };
}

function createSession(
  overrides: Partial<AgentSession> & Pick<AgentSession, "id" | "issueNumber" | "phase">,
): AgentSession {
  const session: AgentSession = {
    id: overrides.id,
    issueNumber: overrides.issueNumber,
    phase: overrides.phase,
    status: overrides.status ?? "in_progress",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
  };

  if (overrides.pullRequestNumber !== undefined) {
    session.pullRequestNumber = overrides.pullRequestNumber;
  }
  if (overrides.completedAt !== undefined) {
    session.completedAt = overrides.completedAt;
  }
  if (overrides.result !== undefined) {
    session.result = overrides.result;
  }

  return session;
}

test("reconcileSessions completes implementation sessions when a linked PR appears", async () => {
  const completedSessions: Array<{ sessionId: string }> = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        updatedAt: "2024-01-01T01:00:00.000Z",
      }),
    ],
    agentSessions: [
      createSession({
        id: "implementation-1",
        issueNumber: 5,
        phase: "implementation",
        createdAt: "2024-01-01T00:30:00.000Z",
      }),
    ],
  };

  await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessions.push({ sessionId });
        return undefined;
      },
      async failSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, [{ sessionId: "implementation-1" }]);
});

test("reconcileSessions completes review sessions with unresolved thread counts", async () => {
  const completedSessions: Array<{ sessionId: string; reviewCommentCount?: number }> = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
      }),
    ],
    agentSessions: [
      createSession({
        id: "review-1",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "review",
        createdAt: "2024-01-01T00:30:00.000Z",
      }),
    ],
  };

  await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 2;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [{ submittedAt: "2024-01-01T01:00:00.000Z" }];
      },
    },
    {
      async completeSession(
        sessionId: string,
        result,
      ): Promise<AgentSession | undefined> {
        const completedSession: { sessionId: string; reviewCommentCount?: number } = {
          sessionId,
        };
        if (result?.reviewCommentCount !== undefined) {
          completedSession.reviewCommentCount = result.reviewCommentCount;
        }
        completedSessions.push(completedSession);
        return undefined;
      },
      async failSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, [
    { sessionId: "review-1", reviewCommentCount: 2 },
  ]);
});

test("reconcileSessions completes final-description sessions from updated PR bodies", async () => {
  const completedSessions: Array<{ sessionId: string; generatedDescription?: string }> = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        body: "Updated final description",
        updatedAt: "2024-01-01T01:00:00.000Z",
      }),
    ],
    agentSessions: [
      createSession({
        id: "final-description-1",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "final-description",
        createdAt: "2024-01-01T00:30:00.000Z",
        result: { pullRequestBody: "Previous final description" },
      }),
    ],
  };

  await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(
        sessionId: string,
        result,
      ): Promise<AgentSession | undefined> {
        const completedSession: { sessionId: string; generatedDescription?: string } = {
          sessionId,
        };
        if (result?.generatedDescription !== undefined) {
          completedSession.generatedDescription = result.generatedDescription;
        }
        completedSessions.push(completedSession);
        return undefined;
      },
      async failSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, [
    {
      sessionId: "final-description-1",
      generatedDescription: "Updated final description",
    },
  ]);
});

test("reconcileSessions does not complete address-review-comments sessions when the PR head sha is unchanged", async () => {
  const completedSessions: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        headSha: "sha-1",
        updatedAt: "2024-01-01T01:00:00.000Z",
      }),
    ],
    agentSessions: [
      createSession({
        id: "address-review-comments-1",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "address-review-comments",
        createdAt: "2024-01-01T00:30:00.000Z",
        result: { pullRequestHeadSha: "sha-1" },
      }),
    ],
  };

  await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessions.push(sessionId);
        return undefined;
      },
      async failSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, []);
});

test("reconcileSessions completes address-review-comments sessions when the PR head sha changes", async () => {
  const completedSessions: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        headSha: "sha-2",
      }),
    ],
    agentSessions: [
      createSession({
        id: "address-review-comments-2",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "address-review-comments",
        result: { pullRequestHeadSha: "sha-1" },
      }),
    ],
  };

  await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessions.push(sessionId);
        return undefined;
      },
      async failSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, ["address-review-comments-2"]);
});

test("reconcileSessions completes resolve-conflicts sessions when the PR head sha changes", async () => {
  const completedSessions: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 11,
        linkedIssueNumbers: [6],
        closingIssueNumbers: [6],
        headSha: "sha-resolved",
      }),
    ],
    agentSessions: [
      createSession({
        id: "resolve-conflicts-1",
        issueNumber: 6,
        pullRequestNumber: 11,
        phase: "resolve-conflicts",
        result: { pullRequestHeadSha: "sha-conflicting" },
      }),
    ],
  };

  await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessions.push(sessionId);
        return undefined;
      },
      async failSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, ["resolve-conflicts-1"]);
});

test("reconcileSessions does not complete final-description sessions when the PR body is unchanged", async () => {
  const completedSessions: Array<{ sessionId: string; generatedDescription?: string }> = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        body: "Unchanged final description",
        updatedAt: "2024-01-01T01:00:00.000Z",
      }),
    ],
    agentSessions: [
      createSession({
        id: "final-description-unchanged",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "final-description",
        createdAt: "2024-01-01T00:30:00.000Z",
        result: { pullRequestBody: "Unchanged final description" },
      }),
    ],
  };

  await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(
        sessionId: string,
        result,
      ): Promise<AgentSession | undefined> {
        const completedSession: { sessionId: string; generatedDescription?: string } = {
          sessionId,
        };
        if (result?.generatedDescription !== undefined) {
          completedSession.generatedDescription = result.generatedDescription;
        }
        completedSessions.push(completedSession);
        return undefined;
      },
      async failSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, []);
});

test("reconcileSessions fails stale implementation sessions when Copilot is not assigned to the issue", async () => {
  const failedSessionIds: string[] = [];
  const completedSessionIds: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 7, assignees: ["alice"] })],
    pullRequests: [],
    agentSessions: [
      createSession({
        id: "implementation-stale-1",
        issueNumber: 7,
        phase: "implementation",
      }),
    ],
  };

  const events = await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessionIds.push(sessionId);
        return undefined;
      },
      async failSession(sessionId: string): Promise<AgentSession | undefined> {
        failedSessionIds.push(sessionId);
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessionIds, []);
  assert.deepEqual(failedSessionIds, ["implementation-stale-1"]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, "failed-stale");
  assert.equal(events[0]?.staleReason, "copilot-not-assigned");
});

test("reconcileSessions keeps implementation sessions when Copilot is still assigned to the issue", async () => {
  const failedSessionIds: string[] = [];
  const completedSessionIds: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 8, assignees: ["Copilot"] })],
    pullRequests: [],
    agentSessions: [
      createSession({
        id: "implementation-active-1",
        issueNumber: 8,
        phase: "implementation",
      }),
    ],
  };

  const events = await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessionIds.push(sessionId);
        return undefined;
      },
      async failSession(sessionId: string): Promise<AgentSession | undefined> {
        failedSessionIds.push(sessionId);
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessionIds, []);
  assert.deepEqual(failedSessionIds, []);
  assert.deepEqual(events, []);
});

test("reconcileSessions fails implementation sessions when the issue is closed (not in snapshot)", async () => {
  const failedSessionIds: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [],
    agentSessions: [
      createSession({
        id: "implementation-stale-2",
        issueNumber: 99,
        phase: "implementation",
      }),
    ],
  };

  const events = await reconcileSessions(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
    },
    {
      async completeSession(): Promise<AgentSession | undefined> {
        return undefined;
      },
      async failSession(sessionId: string): Promise<AgentSession | undefined> {
        failedSessionIds.push(sessionId);
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(failedSessionIds, ["implementation-stale-2"]);
  assert.equal(events[0]?.staleReason, "issue-closed");
});
