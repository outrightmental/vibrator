import type { AgentSession, AgentSessionResult, PullRequest, RepositorySnapshot } from "./types.js";

export interface ReconcileGitHubClient {
  countUnresolvedPullRequestReviewThreads(pullRequestNumber: number): Promise<number>;
  listPullRequestReviews(
    pullRequestNumber: number,
  ): Promise<Array<{ submittedAt: string }>>;
}

export interface ReconcileSessionStore {
  completeSession(
    sessionId: string,
    result?: AgentSessionResult,
  ): Promise<AgentSession | undefined>;
}

function isActiveSession(session: AgentSession): boolean {
  return session.status === "queued" || session.status === "in_progress";
}

function updatedAfter(timestamp: string, candidateTimestamp: string): boolean {
  return Date.parse(candidateTimestamp) > Date.parse(timestamp);
}

function findPullRequestForSession(
  snapshot: RepositorySnapshot,
  session: AgentSession,
): PullRequest | undefined {
  if (session.pullRequestNumber !== undefined) {
    return snapshot.pullRequests.find(
      (pullRequest) => pullRequest.number === session.pullRequestNumber,
    );
  }

  return snapshot.pullRequests.find((pullRequest) =>
    pullRequest.linkedIssueNumbers.includes(session.issueNumber),
  );
}

export async function reconcileSessions(
  gitHubClient: ReconcileGitHubClient,
  sessionStore: ReconcileSessionStore,
  snapshot: RepositorySnapshot,
): Promise<void> {
  const activeSessions = snapshot.agentSessions
    .filter(isActiveSession)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  for (const session of activeSessions) {
    const pullRequest = findPullRequestForSession(snapshot, session);

    switch (session.phase) {
      case "implementation":
        if (pullRequest && updatedAfter(session.createdAt, pullRequest.updatedAt)) {
          await sessionStore.completeSession(session.id);
        }
        break;
      case "review":
        if (pullRequest === undefined) {
          break;
        }

        if (session.pullRequestNumber === undefined) {
          break;
        }

        if (
          !(await gitHubClient
            .listPullRequestReviews(session.pullRequestNumber))
            .some((review) => updatedAfter(session.createdAt, review.submittedAt))
        ) {
          break;
        }

        await sessionStore.completeSession(session.id, {
          reviewCommentCount: await gitHubClient.countUnresolvedPullRequestReviewThreads(
            session.pullRequestNumber,
          ),
        });
        break;
      case "address-review-comments":
        if (pullRequest && updatedAfter(session.createdAt, pullRequest.updatedAt)) {
          await sessionStore.completeSession(session.id);
        }
        break;
      case "final-description":
        if (pullRequest && updatedAfter(session.createdAt, pullRequest.updatedAt)) {
          await sessionStore.completeSession(session.id, {
            generatedDescription: pullRequest.body,
          });
        }
        break;
    }
  }
}
