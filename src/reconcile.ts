import { isFailedCopilotReview, isCleanCopilotReview, COPILOT_REVIEWER_LOGIN } from "./github.js";
import type {
  EvaluateReviewCommentsAddressedParams,
  ReviewCommentsAddressedEvaluation,
} from "./local-copilot.js";
import type {
  AgentSession,
  AgentSessionResult,
  AgentSessionStaleReason,
  Issue,
  PullRequest,
  RepositorySnapshot,
} from "./types.js";

export interface ReconcileGitHubClient {
  countUnresolvedPullRequestReviewThreads(pullRequestNumber: number): Promise<number>;
  listPullRequestReviews(
    pullRequestNumber: number,
  ): Promise<
    Array<{
      submittedAt: string;
      authorLogin?: string;
      state?: string;
      body?: string | null;
    }>
  >;
  listCopilotFinishedWorkEvents(
    pullRequestNumber: number,
  ): Promise<Array<{ createdAt: string }>>;
  /**
   * Optional — when implemented, the reconciler uses Copilot "started work"
   * timeline events together with `listCopilotFinishedWorkEvents` and comment
   * reactions to detect whether Copilot has acknowledged a summon. When not
   * implemented, acknowledgment-timeout detection is skipped.
   */
  listCopilotStartedWorkEvents?(
    issueOrPullRequestNumber: number,
  ): Promise<Array<{ createdAt: string }>>;
  /**
   * Optional — when implemented, the reconciler treats an "eyes" reaction on
   * the original prompt comment from Copilot as proof of acknowledgment.
   */
  listIssueCommentReactions?(
    commentId: number,
  ): Promise<Array<{ userLogin: string; content: string }>>;
}

export interface ReconcileLocalCopilotChatClient {
  evaluateReviewCommentsAddressed(
    params: EvaluateReviewCommentsAddressedParams,
  ): Promise<ReviewCommentsAddressedEvaluation>;
}

export interface ReconcileSessionStore {
  completeSession(
    sessionId: string,
    result?: AgentSessionResult,
  ): Promise<AgentSession | undefined>;
  failSession(
    sessionId: string,
    options?: { staleReason?: AgentSessionStaleReason },
  ): Promise<AgentSession | undefined>;
}

export type ReconcileStaleReason = AgentSessionStaleReason;

export interface ReconcileSessionEvent {
  session: AgentSession;
  outcome: "completed" | "failed-stale";
  staleReason?: ReconcileStaleReason;
  /**
   * Free-text rationale captured from the local copilot CLI when an
   * address-review-comments session is resolved by AI evaluation. Useful
   * for operators reviewing why the orchestrator decided DONE/NOT_DONE.
   */
  evaluationRationale?: string;
}

export interface ReconcileContext {
  owner: string;
  repo: string;
  /**
   * How long the reconciler waits, after an active Copilot-summoning session
   * begins, before failing it as `copilot-did-not-acknowledge` when no
   * acknowledgment signal has appeared (no started/finished timeline event,
   * no eyes reaction on the prompt comment, no head SHA change). Defaults to
   * 10 minutes when omitted.
   */
  acknowledgeTimeoutMs?: number;
}

const DEFAULT_ACKNOWLEDGE_TIMEOUT_MS = 10 * 60 * 1000;

const COPILOT_REACTION_USER_LOGINS = new Set([
  "copilot",
  "copilot-swe-agent",
  "copilot[bot]",
  "copilot-swe-agent[bot]",
]);

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
    session.issueNumber !== undefined &&
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

function isSessionPastAcknowledgeTimeout(
  session: AgentSession,
  acknowledgeTimeoutMs: number,
  now: number,
): boolean {
  const createdAtMs = Date.parse(session.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return now - createdAtMs >= acknowledgeTimeoutMs;
}

/**
 * Returns true when GitHub has reported a signal proving Copilot picked up
 * the summon associated with this session. The reconciler considers any of
 * the following sufficient acknowledgment:
 *
 *   - a "Copilot started/picked up/queued" timeline event on the linked
 *     issue or PR after the session began;
 *   - a "Copilot finished work" timeline event after the session began
 *     (proves Copilot ran a session even if it ended without code changes);
 *   - an "eyes" reaction from a Copilot user account on the prompt comment
 *     that vibrator posted (when `session.result.promptCommentId` is set).
 *
 * `timelineSubjectNumber` is the issue or PR number whose timeline carries
 * Copilot's start/finish events for this session. Returns `false` when the
 * GitHub client does not support the relevant lookups (best-effort
 * detection only).
 */
async function hasCopilotAcknowledgedSession(
  gitHubClient: ReconcileGitHubClient,
  session: AgentSession,
  timelineSubjectNumber: number,
): Promise<boolean> {
  const sessionStartMs = Date.parse(session.createdAt);
  if (Number.isNaN(sessionStartMs)) {
    return true; // be conservative — don't fail sessions with malformed timestamps
  }

  if (gitHubClient.listCopilotStartedWorkEvents) {
    const startedEvents = await gitHubClient.listCopilotStartedWorkEvents(
      timelineSubjectNumber,
    );
    if (startedEvents.some((event) => Date.parse(event.createdAt) > sessionStartMs)) {
      return true;
    }
  }

  const finishedEvents = await gitHubClient.listCopilotFinishedWorkEvents(
    timelineSubjectNumber,
  );
  if (finishedEvents.some((event) => Date.parse(event.createdAt) > sessionStartMs)) {
    return true;
  }

  const promptCommentId = session.result?.promptCommentId;
  if (promptCommentId !== undefined && gitHubClient.listIssueCommentReactions) {
    const reactions = await gitHubClient.listIssueCommentReactions(promptCommentId);
    if (
      reactions.some(
        (reaction) =>
          reaction.content === "eyes" &&
          COPILOT_REACTION_USER_LOGINS.has(reaction.userLogin.toLowerCase()),
      )
    ) {
      return true;
    }
  }

  return false;
}

export async function reconcileSessions(
  gitHubClient: ReconcileGitHubClient,
  sessionStore: ReconcileSessionStore,
  snapshot: RepositorySnapshot,
  localCopilotChatClient: ReconcileLocalCopilotChatClient,
  context: ReconcileContext,
  now: number = Date.now(),
): Promise<ReconcileSessionEvent[]> {
  const events: ReconcileSessionEvent[] = [];
  const acknowledgeTimeoutMs =
    context.acknowledgeTimeoutMs ?? DEFAULT_ACKNOWLEDGE_TIMEOUT_MS;
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
          // The Copilot coding agent opens its draft PR at the very start
          // of an implementation session — long before any code is written.
          // Treating PR existence as "implementation complete" caused the
          // orchestrator to request a Copilot review while Copilot was
          // still actively implementing the change. Use the authoritative
          // "Copilot finished work" timeline event (the same signal used
          // by the address-review-comments reconciler) to decide whether
          // Copilot has actually finished this implementation session.
          const finishedWorkEvents = await gitHubClient.listCopilotFinishedWorkEvents(
            pullRequest.number,
          );
          const sessionStartMs = Date.parse(session.createdAt);
          const hasFinishedAfterSession = finishedWorkEvents.some(
            (event) => Date.parse(event.createdAt) > sessionStartMs,
          );
          if (hasFinishedAfterSession) {
            await sessionStore.completeSession(session.id);
            events.push({ session, outcome: "completed" });
            break;
          }

          // No finished event yet. Copilot may still be working — check for
          // any acknowledgment signal (start event, finished event, or
          // "eyes" reaction on the prompt comment, where applicable). If
          // none has appeared by the acknowledge-timeout, fail the session
          // so the orchestrator can unassign + re-assign Copilot on the
          // next planning iteration.
          if (isSessionPastAcknowledgeTimeout(session, acknowledgeTimeoutMs, now)) {
            const acknowledged = await hasCopilotAcknowledgedSession(
              gitHubClient,
              session,
              pullRequest.number,
            );
            if (!acknowledged) {
              await sessionStore.failSession(session.id, {
                staleReason: "copilot-did-not-acknowledge",
              });
              events.push({
                session,
                outcome: "failed-stale",
                staleReason: "copilot-did-not-acknowledge",
              });
            }
          }
          break;
        }

        {
          if (session.issueNumber === undefined) {
            break;
          }
          const issue = issuesByNumber.get(session.issueNumber);
          if (!issue) {
            await sessionStore.failSession(session.id, { staleReason: "issue-closed" });
            events.push({ session, outcome: "failed-stale", staleReason: "issue-closed" });
            break;
          }

          if (!isCopilotAssigned(issue)) {
            await sessionStore.failSession(session.id, {
              staleReason: "copilot-not-assigned",
            });
            events.push({
              session,
              outcome: "failed-stale",
              staleReason: "copilot-not-assigned",
            });
            break;
          }

          // Copilot is assigned but no PR has appeared yet. The Copilot
          // coding agent normally opens its draft PR within seconds. If we
          // pass the acknowledge timeout with no PR and no acknowledgment
          // signal on the issue timeline, treat the assignment as ignored
          // and fail so the orchestrator can unassign + re-assign.
          if (isSessionPastAcknowledgeTimeout(session, acknowledgeTimeoutMs, now)) {
            const acknowledged = await hasCopilotAcknowledgedSession(
              gitHubClient,
              session,
              session.issueNumber,
            );
            if (!acknowledged) {
              await sessionStore.failSession(session.id, {
                staleReason: "copilot-did-not-acknowledge",
              });
              events.push({
                session,
                outcome: "failed-stale",
                staleReason: "copilot-did-not-acknowledge",
              });
            }
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

        {
          const reviewsAfterSession = (
            await gitHubClient.listPullRequestReviews(session.pullRequestNumber)
          ).filter(
            (review) => Date.parse(review.submittedAt) > Date.parse(session.createdAt),
          );
          if (reviewsAfterSession.length === 0) {
            break;
          }

          // If Copilot's most recent attempt to review this PR returned the
          // "wasn't able to review any files" failure message, do NOT treat
          // that as an approval. Fail the session so the orchestrator
          // re-requests a Copilot review on the next iteration. Without this
          // guard the failure review (state=COMMENTED, 0 inline comments) is
          // indistinguishable from a clean review and the PR would advance
          // straight to squash-and-merge.
          const latestCopilotReview = [...reviewsAfterSession]
            .filter(
              (review) =>
                review.authorLogin?.toLowerCase() === COPILOT_REVIEWER_LOGIN,
            )
            .sort(
              (left, right) =>
                Date.parse(right.submittedAt) - Date.parse(left.submittedAt),
            )[0];
          if (latestCopilotReview && isFailedCopilotReview(latestCopilotReview)) {
            await sessionStore.failSession(session.id, {
              staleReason: "copilot-review-failed",
            });
            events.push({
              session,
              outcome: "failed-stale",
              staleReason: "copilot-review-failed",
            });
            break;
          }

          const unresolvedReviewCommentCount =
            await gitHubClient.countUnresolvedPullRequestReviewThreads(
              session.pullRequestNumber,
            );

          // When zero review comments / unresolved threads exist after the
          // request, we need an *explicit* clean-review signal from the
          // Copilot reviewer bot before treating the PR as ready for
          // squash-and-merge. Without this guard, a "completed" review
          // session with 0 comments (e.g. Copilot never actually reviewed,
          // or a human submitted a non-Copilot review that left no inline
          // threads) would flow straight to write-final-description →
          // merge-pull-request and merge an unreviewed PR — including PRs
          // still titled `[WIP] …`. Fail the session so the orchestrator
          // re-requests a Copilot review on the next iteration.
          if (unresolvedReviewCommentCount === 0) {
            const hasCleanCopilotReview = reviewsAfterSession.some((review) =>
              isCleanCopilotReview({
                authorLogin: review.authorLogin,
                state: review.state,
                body: review.body,
                reviewCommentCount: 0,
              }),
            );
            if (!hasCleanCopilotReview) {
              await sessionStore.failSession(session.id, {
                staleReason: "copilot-review-incomplete",
              });
              events.push({
                session,
                outcome: "failed-stale",
                staleReason: "copilot-review-incomplete",
              });
              break;
            }
          }

          await sessionStore.completeSession(session.id, {
            reviewCommentCount: unresolvedReviewCommentCount,
          });
          events.push({ session, outcome: "completed" });
        }
        break;
      case "address-review-comments":
        if (pullRequest === undefined) {
          break;
        }
        if (hasUpdatedHeadSha(session, pullRequest)) {
          await sessionStore.completeSession(session.id);
          events.push({ session, outcome: "completed" });
          break;
        }

        if (session.pullRequestNumber === undefined) {
          break;
        }

        // Copilot may end its session by posting a comment ("no change
        // needed") without pushing any commits. In that case the head SHA
        // never updates and the session would sit forever waiting. Detect
        // the "Copilot finished work" timeline event after session.createdAt
        // and, when found, ask the local copilot CLI to evaluate whether
        // every review comment is actually addressed. The CLI's verdict
        // (DONE / NOT_DONE) decides whether to complete or fail the
        // session — failing it lets the orchestrator re-issue the
        // address-review-comments action on the next iteration.
        {
          const finishedWorkEvents = await gitHubClient.listCopilotFinishedWorkEvents(
            session.pullRequestNumber,
          );
          const sessionStartMs = Date.parse(session.createdAt);
          const hasFinishedAfterSession = finishedWorkEvents.some(
            (event) => Date.parse(event.createdAt) > sessionStartMs,
          );
          if (!hasFinishedAfterSession) {
            // No finished event yet. Before just waiting indefinitely,
            // check whether Copilot has even acknowledged the request.
            // After the acknowledge timeout with no start/finish event and
            // no eyes reaction on the prompt comment, fail the session so
            // the orchestrator can unassign + re-assign + re-post.
            if (isSessionPastAcknowledgeTimeout(session, acknowledgeTimeoutMs, now)) {
              const acknowledged = await hasCopilotAcknowledgedSession(
                gitHubClient,
                session,
                session.pullRequestNumber,
              );
              if (!acknowledged) {
                await sessionStore.failSession(session.id, {
                  staleReason: "copilot-did-not-acknowledge",
                });
                events.push({
                  session,
                  outcome: "failed-stale",
                  staleReason: "copilot-did-not-acknowledge",
                });
              }
            }
            break;
          }

          const evaluation = await localCopilotChatClient.evaluateReviewCommentsAddressed({
            owner: context.owner,
            repo: context.repo,
            pullRequestNumber: session.pullRequestNumber,
          });

          if (evaluation.verdict === "DONE") {
            await sessionStore.completeSession(session.id);
            events.push({
              session,
              outcome: "completed",
              evaluationRationale: evaluation.rationale,
            });
          } else {
            await sessionStore.failSession(session.id, {
              staleReason: "copilot-review-comments-not-addressed",
            });
            events.push({
              session,
              outcome: "failed-stale",
              staleReason: "copilot-review-comments-not-addressed",
              evaluationRationale: evaluation.rationale,
            });
          }
        }
        break;
      case "resolve-conflicts":
        if (pullRequest && hasUpdatedHeadSha(session, pullRequest)) {
          await sessionStore.completeSession(session.id);
          events.push({ session, outcome: "completed" });
          break;
        }
        // No head SHA change yet. Check whether Copilot has acknowledged the
        // resolve-conflicts request; if not within the acknowledge-timeout,
        // fail so the orchestrator can unassign + re-assign + re-post.
        if (
          pullRequest &&
          session.pullRequestNumber !== undefined &&
          isSessionPastAcknowledgeTimeout(session, acknowledgeTimeoutMs, now)
        ) {
          const acknowledged = await hasCopilotAcknowledgedSession(
            gitHubClient,
            session,
            session.pullRequestNumber,
          );
          if (!acknowledged) {
            await sessionStore.failSession(session.id, {
              staleReason: "copilot-did-not-acknowledge",
            });
            events.push({
              session,
              outcome: "failed-stale",
              staleReason: "copilot-did-not-acknowledge",
            });
          }
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
