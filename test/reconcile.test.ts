import test from "node:test";
import assert from "node:assert/strict";

import { reconcileSessions } from "../src/reconcile.js";
import type { AgentSession, PullRequest, RepositorySnapshot } from "../src/types.js";

function createPullRequest(
  overrides: Partial<PullRequest> &
    Pick<PullRequest, "number" | "linkedIssueNumbers" | "closingIssueNumbers">,
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
