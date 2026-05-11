import type { AgentSession, AgentSessionResult, Issue, PullRequest, RepositorySnapshot } from "./types.js";

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
  failSession(sessionId: string): Promise<AgentSession | undefined>;
}

export type ReconcileStaleReason = "issue-closed" | "copilot-not-assigned";

export interface ReconcileSessionEvent {
  session: AgentSession;
  outcome: "completed" | "failed-stale";
  staleReason?: ReconcileStaleReason;
}

const COPILOT_ASSIGNEE_LOGINS = new Set(["copilot", "copilot-swe-agent"]);

function isCopilotAssigned(issue: Issue): boolean {
  return issue.assignees.some((login) => COPILOT_ASSIGNEE_LOGINS.has(login.toLowerCase()));
}

function isActiveSession(session: AgentSession): boolean {
  return session.status === "queued" || session.status === "in_progress";
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

function hasUpdatedHeadSha(session: AgentSession, pullRequest: PullRequest): boolean {
  return (
    session.result?.pullRequestHeadSha !== undefined &&
    pullRequest.headSha !== session.result.pullRequestHeadSha
  );
}

function hasUpdatedPullRequestBody(session: AgentSession, pullRequest: PullRequest): boolean {
  return (
    session.result?.pullRequestBody !== undefined &&
    pullRequest.body !== session.result.pullRequestBody
  );
}

export async function reconcileSessions(
  gitHubClient: ReconcileGitHubClient,
  sessionStore: ReconcileSessionStore,
  snapshot: RepositorySnapshot,
): Promise<ReconcileSessionEvent[]> {
  const events: ReconcileSessionEvent[] = [];
  const activeSessions = snapshot.agentSessions
    .filter(isActiveSession)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  const issuesByNumber = new Map<number, Issue>(
    snapshot.issues.map((issue) => [issue.number, issue]),
  );

  for (const session of activeSessions) {
    const pullRequest = findPullRequestForSession(snapshot, session);

    switch (session.phase) {
      case "implementation":
        if (pullRequest) {
          await sessionStore.completeSession(session.id);
          events.push({ session, outcome: "completed" });
          break;
        }

        {
          const issue = issuesByNumber.get(session.issueNumber);
          if (!issue) {
            await sessionStore.failSession(session.id);
            events.push({ session, outcome: "failed-stale", staleReason: "issue-closed" });
            break;
          }

          if (!isCopilotAssigned(issue)) {
            await sessionStore.failSession(session.id);
            events.push({
              session,
              outcome: "failed-stale",
              staleReason: "copilot-not-assigned",
            });
          }
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
            .some((review) => Date.parse(review.submittedAt) > Date.parse(session.createdAt))
        ) {
          break;
        }

        await sessionStore.completeSession(session.id, {
          reviewCommentCount: await gitHubClient.countUnresolvedPullRequestReviewThreads(
            session.pullRequestNumber,
          ),
        });
        events.push({ session, outcome: "completed" });
        break;
      case "address-review-comments":
        if (pullRequest && hasUpdatedHeadSha(session, pullRequest)) {
          await sessionStore.completeSession(session.id);
          events.push({ session, outcome: "completed" });
        }
        break;
      case "final-description":
        if (pullRequest && hasUpdatedPullRequestBody(session, pullRequest)) {
          await sessionStore.completeSession(session.id, {
            generatedDescription: pullRequest.body,
          });
          events.push({ session, outcome: "completed" });
        }
        break;
    }
  }

  return events;
}
