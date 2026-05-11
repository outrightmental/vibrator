import test from "node:test";
import assert from "node:assert/strict";

import { reconcileSessions } from "../src/reconcile.js";
import type {
  ReconcileGitHubClient,
  ReconcileLocalCopilotChatClient,
  ReconcileSessionEvent,
  ReconcileSessionStore,
} from "../src/reconcile.js";
import type { AgentSession, Issue, PullRequest, RepositorySnapshot } from "../src/types.js";

const DEFAULT_CONTEXT = { owner: "octo", repo: "vibrator" } as const;

const REJECTING_LOCAL_COPILOT_CHAT_CLIENT: ReconcileLocalCopilotChatClient = {
  async evaluateReviewCommentsAddressed() {
    throw new Error(
      "evaluateReviewCommentsAddressed should not be called by this test",
    );
  },
};

async function runReconcile(
  gitHubClient: Partial<ReconcileGitHubClient>,
  sessionStore: ReconcileSessionStore,
  snapshot: RepositorySnapshot,
  localCopilotChatClient: ReconcileLocalCopilotChatClient = REJECTING_LOCAL_COPILOT_CHAT_CLIENT,
): Promise<ReconcileSessionEvent[]> {
  const filledGitHubClient: ReconcileGitHubClient = {
    async countUnresolvedPullRequestReviewThreads(): Promise<number> {
      return 0;
    },
    async listPullRequestReviews() {
      return [];
    },
    async listCopilotFinishedWorkEvents() {
      return [];
    },
    ...gitHubClient,
  };
  return reconcileSessions(
    filledGitHubClient,
    sessionStore,
    snapshot,
    localCopilotChatClient,
    DEFAULT_CONTEXT,
  );
}

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
  overrides: Partial<PullRequest> &
    Pick<PullRequest, "number" | "linkedIssueNumbers" | "closingIssueNumbers">,
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

test("reconcileSessions completes implementation sessions when Copilot has finished work after the session started", async () => {
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

  await runReconcile(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
      async listCopilotFinishedWorkEvents(): Promise<Array<{ createdAt: string }>> {
        return [{ createdAt: "2024-01-01T00:45:00.000Z" }];
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

test("reconcileSessions keeps implementation sessions in progress while Copilot is still working on the draft PR", async () => {
  // Regression test: the Copilot coding agent opens its draft PR at the very
  // start of an implementation session, before any code is written. The
  // reconciler must not treat the existence of the PR as "implementation
  // done" — otherwise the orchestrator immediately requests a review while
  // Copilot is still implementing the change.
  const completedSessions: Array<{ sessionId: string }> = [];
  const failedSessions: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({
        number: 5,
        assignees: ["copilot-swe-agent"],
      }),
    ],
    pullRequests: [
      createPullRequest({
        number: 10,
        draft: true,
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

  const events = await runReconcile(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews(): Promise<Array<{ submittedAt: string }>> {
        return [];
      },
      async listCopilotFinishedWorkEvents(): Promise<Array<{ createdAt: string }>> {
        // No finished-work event after the session started — Copilot is
        // still implementing.
        return [];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessions.push({ sessionId });
        return undefined;
      },
      async failSession(sessionId: string): Promise<AgentSession | undefined> {
        failedSessions.push(sessionId);
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, []);
  assert.deepEqual(failedSessions, []);
  assert.deepEqual(events, []);
});

test("reconcileSessions ignores finished-work events that predate the implementation session", async () => {
  // A "Copilot finished work" event from a prior session (e.g. an earlier
  // implementation attempt that produced the draft PR) must not mark the
  // current implementation session as complete.
  const completedSessions: Array<{ sessionId: string }> = [];
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({
        number: 5,
        assignees: ["copilot-swe-agent"],
      }),
    ],
    pullRequests: [
      createPullRequest({
        number: 10,
        draft: true,
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

  await runReconcile(
    {
      async listCopilotFinishedWorkEvents(): Promise<Array<{ createdAt: string }>> {
        return [{ createdAt: "2024-01-01T00:00:00.000Z" }];
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

  assert.deepEqual(completedSessions, []);
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

  await runReconcile(
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

test("reconcileSessions fails review sessions when Copilot replies that it wasn't able to review", async () => {
  const completedSessions: string[] = [];
  const failedSessions: string[] = [];
  const countUnresolvedCalls: number[] = [];
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

  const events = await runReconcile(
    {
      async countUnresolvedPullRequestReviewThreads(
        pullRequestNumber: number,
      ): Promise<number> {
        countUnresolvedCalls.push(pullRequestNumber);
        return 0;
      },
      async listPullRequestReviews() {
        return [
          {
            submittedAt: "2024-01-01T01:00:00.000Z",
            authorLogin: "Copilot-pull-request-reviewer",
            state: "COMMENTED",
            body: "Copilot wasn't able to review any files in this pull request.",
          },
        ];
      },
    },
    {
      async completeSession(sessionId: string): Promise<AgentSession | undefined> {
        completedSessions.push(sessionId);
        return undefined;
      },
      async failSession(sessionId: string): Promise<AgentSession | undefined> {
        failedSessions.push(sessionId);
        return undefined;
      },
    },
    snapshot,
  );

  assert.deepEqual(completedSessions, []);
  assert.deepEqual(failedSessions, ["review-1"]);
  assert.deepEqual(countUnresolvedCalls, []);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, "failed-stale");
  assert.equal(events[0]?.staleReason, "copilot-review-failed");
});

test("reconcileSessions completes review sessions when Copilot replies with a successful empty review", async () => {
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

  await runReconcile(
    {
      async countUnresolvedPullRequestReviewThreads(): Promise<number> {
        return 0;
      },
      async listPullRequestReviews() {
        return [
          {
            submittedAt: "2024-01-01T01:00:00.000Z",
            authorLogin: "copilot-pull-request-reviewer",
            state: "COMMENTED",
            body: "Copilot reviewed 3 files in this pull request and generated no comments.",
          },
        ];
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
    { sessionId: "review-1", reviewCommentCount: 0 },
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

  await runReconcile(
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

  await runReconcile(
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

  await runReconcile(
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

  await runReconcile(
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

  await runReconcile(
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

  const events = await runReconcile(
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

  const events = await runReconcile(
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

  const events = await runReconcile(
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

test("reconcileSessions completes address-review-comments via copilot CLI evaluation when verdict is DONE", async () => {
  const completedSessionIds: string[] = [];
  const failedSessionIds: string[] = [];
  const evaluateCalls: Array<{ pullRequestNumber: number }> = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        headSha: "sha-1",
      }),
    ],
    agentSessions: [
      createSession({
        id: "address-1",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "address-review-comments",
        createdAt: "2024-01-01T00:30:00.000Z",
        result: { pullRequestHeadSha: "sha-1" },
      }),
    ],
  };

  const events = await runReconcile(
    {
      async listCopilotFinishedWorkEvents() {
        return [{ createdAt: "2024-01-01T01:00:00.000Z" }];
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
    {
      async evaluateReviewCommentsAddressed(params) {
        evaluateCalls.push({ pullRequestNumber: params.pullRequestNumber });
        return { verdict: "DONE", rationale: "tests already cover this case" };
      },
    },
  );

  assert.deepEqual(completedSessionIds, ["address-1"]);
  assert.deepEqual(failedSessionIds, []);
  assert.deepEqual(evaluateCalls, [{ pullRequestNumber: 10 }]);
  assert.equal(events[0]?.outcome, "completed");
  assert.equal(events[0]?.evaluationRationale, "tests already cover this case");
});

test("reconcileSessions fails address-review-comments via copilot CLI evaluation when verdict is NOT_DONE", async () => {
  const completedSessionIds: string[] = [];
  const failedSessionIds: string[] = [];
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        headSha: "sha-1",
      }),
    ],
    agentSessions: [
      createSession({
        id: "address-1",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "address-review-comments",
        createdAt: "2024-01-01T00:30:00.000Z",
        result: { pullRequestHeadSha: "sha-1" },
      }),
    ],
  };

  const events = await runReconcile(
    {
      async listCopilotFinishedWorkEvents() {
        return [{ createdAt: "2024-01-01T01:00:00.000Z" }];
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
    {
      async evaluateReviewCommentsAddressed() {
        return { verdict: "NOT_DONE", rationale: "comment X still requires a code change" };
      },
    },
  );

  assert.deepEqual(completedSessionIds, []);
  assert.deepEqual(failedSessionIds, ["address-1"]);
  assert.equal(events[0]?.outcome, "failed-stale");
  assert.equal(events[0]?.staleReason, "copilot-review-comments-not-addressed");
  assert.equal(events[0]?.evaluationRationale, "comment X still requires a code change");
});

test("reconcileSessions waits when no Copilot finished-work event has occurred yet", async () => {
  const completedSessionIds: string[] = [];
  const failedSessionIds: string[] = [];
  let evaluateCalled = false;
  const snapshot: RepositorySnapshot = {
    issues: [],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [5],
        closingIssueNumbers: [5],
        headSha: "sha-1",
      }),
    ],
    agentSessions: [
      createSession({
        id: "address-1",
        issueNumber: 5,
        pullRequestNumber: 10,
        phase: "address-review-comments",
        createdAt: "2024-01-01T00:30:00.000Z",
        result: { pullRequestHeadSha: "sha-1" },
      }),
    ],
  };

  await runReconcile(
    {
      // The only finished-work event predates the session, so it must be ignored.
      async listCopilotFinishedWorkEvents() {
        return [{ createdAt: "2024-01-01T00:00:00.000Z" }];
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
    {
      async evaluateReviewCommentsAddressed() {
        evaluateCalled = true;
        return { verdict: "DONE", rationale: "" };
      },
    },
  );

  assert.deepEqual(completedSessionIds, []);
  assert.deepEqual(failedSessionIds, []);
  assert.equal(evaluateCalled, false);
});
