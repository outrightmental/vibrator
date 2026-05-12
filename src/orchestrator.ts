import type {
  AgentSession,
  Issue,
  OrchestratorAction,
  OrchestratorPlan,
  PullRequest,
  RepositorySnapshot,
} from "./types.js";

const BLOCKED_BY_PATTERN = /\b(?:blocked by|depends on)\s+#(\d+)\b/gi;
const BLOCKS_PATTERN = /\bblocks\s+#(\d+)\b/gi;
const CLOSING_ISSUE_KEYWORDS = ["close[sd]?", "fix(?:e[sd]?|es)?", "resolve[sd]?"] as const;
const LINKED_ISSUE_KEYWORDS = [...CLOSING_ISSUE_KEYWORDS, "implement(?:s|ed)?", "for"] as const;
const CLOSING_ISSUE_KEYWORD_PATTERN = String.raw`(?:${CLOSING_ISSUE_KEYWORDS.join("|")})`;
const LINKED_ISSUE_KEYWORD_PATTERN = String.raw`(?:${LINKED_ISSUE_KEYWORDS.join("|")})`;
const CLOSING_ISSUE_PATTERN = new RegExp(
  String.raw`\b${CLOSING_ISSUE_KEYWORD_PATTERN}\s*:?\s*#(\d+)\b`,
  "gi",
);
const LINKED_ISSUE_PATTERN = new RegExp(
  String.raw`\b${LINKED_ISSUE_KEYWORD_PATTERN}\s*:?\s*#(\d+)\b`,
  "gi",
);

const ACTIVE_STATUSES = new Set(["queued", "in_progress"]);

/**
 * Matches a PR title still flagged as work-in-progress. Copilot opens its
 * draft PRs with a `[WIP] …` title prefix while it is still pushing
 * commits and removes the prefix once it considers the change complete.
 * Accepts case-insensitive `[wip]` bracketed prefixes or a leading `wip:`
 * token (with optional surrounding whitespace). PRs whose titles still
 * match this pattern must NOT be reviewed, approved, or merged — the
 * orchestrator skips them entirely until the prefix is cleaned up.
 */
const WIP_TITLE_PATTERN = /^\s*(?:\[\s*wip\s*\]|wip\s*:)/i;

export function isWorkInProgressPullRequest(pullRequest: PullRequest): boolean {
  return WIP_TITLE_PATTERN.test(pullRequest.title);
}

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sortByCreatedAt<T extends { createdAt: string; number: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return timeDifference === 0 ? left.number - right.number : timeDifference;
  });
}

/**
 * Lower number = higher priority. Bugs (GitHub issue Type === "Bug",
 * case-insensitively) jump ahead of every other type — features, tasks,
 * chores, untyped issues — because an open bug with no blocking
 * relationships should always be addressed before new feature/task work.
 * Compared on the native issue Type field, NOT labels.
 */
function issuePriority(issue: Issue): number {
  if (issue.type?.toLowerCase() === "bug") {
    return 0;
  }
  return 1;
}

function appendMatches(target: Set<number>, source: string, pattern: RegExp): void {
  for (const match of source.matchAll(pattern)) {
    const capturedIssueNumber = match[1];
    if (!capturedIssueNumber) {
      continue;
    }

    const issueNumber = Number.parseInt(capturedIssueNumber, 10);
    if (!Number.isNaN(issueNumber)) {
      target.add(issueNumber);
    }
  }
}

export function parseBlockingRelationships(issue: Issue): number[] {
  const dependencies = new Set<number>();
  appendMatches(dependencies, issue.body, BLOCKED_BY_PATTERN);
  return uniqueSorted(dependencies);
}

export function parseBlockedIssueRelationships(issue: Issue): number[] {
  const blockedIssues = new Set<number>();
  appendMatches(blockedIssues, issue.body, BLOCKS_PATTERN);
  return uniqueSorted(blockedIssues);
}

export function parseLinkedIssueNumbers(text: string): number[] {
  const linkedIssues = new Set<number>();
  appendMatches(linkedIssues, text, LINKED_ISSUE_PATTERN);
  return uniqueSorted(linkedIssues);
}

export function parseClosingIssueNumbers(text: string): number[] {
  const closingIssues = new Set<number>();
  appendMatches(closingIssues, text, CLOSING_ISSUE_PATTERN);
  return uniqueSorted(closingIssues);
}

export function buildBlockedIssueIndex(issues: Issue[]): Record<number, number[]> {
  const blockedIssueIndex = new Map<number, Set<number>>();

  for (const issue of issues) {
    for (const blocker of parseBlockingRelationships(issue)) {
      const blockers = blockedIssueIndex.get(issue.number) ?? new Set<number>();
      blockers.add(blocker);
      blockedIssueIndex.set(issue.number, blockers);
    }

    for (const blockedIssue of parseBlockedIssueRelationships(issue)) {
      const blockers = blockedIssueIndex.get(blockedIssue) ?? new Set<number>();
      blockers.add(issue.number);
      blockedIssueIndex.set(blockedIssue, blockers);
    }
  }

  return Object.fromEntries(
    [...blockedIssueIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([issueNumber, blockers]) => [issueNumber, uniqueSorted(blockers)]),
  );
}

function isActiveSession(session: AgentSession): boolean {
  return ACTIVE_STATUSES.has(session.status);
}

function buildPullRequestIndex(pullRequests: PullRequest[]): Map<number, PullRequest> {
  const index = new Map<number, PullRequest>();
  for (const pullRequest of pullRequests) {
    for (const issueNumber of pullRequest.linkedIssueNumbers) {
      if (!index.has(issueNumber)) {
        index.set(issueNumber, pullRequest);
      }
    }
  }
  return index;
}

function getRelevantSessions(
  agentSessions: AgentSession[],
  issueNumbers: readonly number[],
  pullRequestNumber: number,
): AgentSession[] {
  const issueNumberSet = new Set(issueNumbers);
  return agentSessions
    .filter(
      (session) =>
        (session.issueNumber !== undefined && issueNumberSet.has(session.issueNumber)) ||
        session.pullRequestNumber === pullRequestNumber,
    )
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
}

function getLatestCompletedSession(agentSessions: AgentSession[]): AgentSession | undefined {
  return [...agentSessions]
    .filter((session) => session.status === "completed")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

/**
 * Returns true when the most recent terminal (completed or failed) review
 * session for this PR ended in failure. Used to detect the "Copilot wasn't
 * able to review any files" failure mode so the next review request can
 * include a draft → ready-for-review reset (GitHub's documented recovery).
 * A subsequent successful (completed) review on the same PR clears the
 * signal — we only reset when the *latest* review attempt failed.
 */
function hasFailedLatestReviewSession(agentSessions: AgentSession[]): boolean {
  const latestReviewSession = [...agentSessions]
    .filter(
      (session) =>
        session.phase === "review" &&
        (session.status === "completed" || session.status === "failed"),
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  return latestReviewSession?.status === "failed";
}

/**
 * Returns true when the most recent terminal session for `phase` failed
 * with `staleReason === "copilot-did-not-acknowledge"` AND no subsequent
 * successful (`completed`) session for the same phase has cleared it.
 * Used to set the `reassignCopilot` flag on the next action so the
 * executor unassigns + re-assigns Copilot before re-summoning.
 */
function shouldReassignCopilotForPhase(
  agentSessions: readonly AgentSession[],
  phase: AgentSession["phase"],
): boolean {
  const latestTerminalForPhase = [...agentSessions]
    .filter(
      (session) =>
        session.phase === phase &&
        (session.status === "completed" || session.status === "failed"),
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  return (
    latestTerminalForPhase?.status === "failed" &&
    latestTerminalForPhase.staleReason === "copilot-did-not-acknowledge"
  );
}

function planPullRequestAction(
  pullRequest: PullRequest,
  issueNumbers: readonly number[],
  agentSessions: AgentSession[],
): OrchestratorAction | undefined {
  const primaryIssueNumber = issueNumbers[0];

  const relevantSessions = getRelevantSessions(agentSessions, issueNumbers, pullRequest.number);
  if (relevantSessions.some(isActiveSession)) {
    return undefined;
  }

  // A PR whose title is still `[WIP] …` (or `wip: …`) is not ready for
  // review or merge. Copilot opens its draft PRs with that prefix while
  // it is still pushing commits and removes it once the change is
  // complete. Skip the PR entirely until the title is cleaned up so we
  // never request a review against — let alone merge — a work-in-progress
  // PR.
  if (isWorkInProgressPullRequest(pullRequest)) {
    return undefined;
  }

  const latestCompletedSession = getLatestCompletedSession(relevantSessions);
  // When the most recent Copilot review attempt failed (typically the
  // "Copilot wasn't able to review any files in this pull request." message
  // — reconcile fails those review sessions), the next review request must
  // first toggle the PR draft → ready-for-review to reset Copilot's review
  // state. Without this reset Copilot tends to ignore the new review
  // request and the orchestrator spins re-requesting a review that never
  // arrives.
  const shouldResetDraftStateBeforeReview = hasFailedLatestReviewSession(relevantSessions);
  const completedSessionIssueNumber = latestCompletedSession?.issueNumber;
  // Keep PR-level work attached to the issue that most recently advanced this PR when possible.
  // For PRs with no linked issue, actionIssueNumber stays undefined.
  const actionIssueNumber =
    completedSessionIssueNumber !== undefined &&
    issueNumbers.includes(completedSessionIssueNumber)
      ? completedSessionIssueNumber
      : primaryIssueNumber;

  type ActionWithoutIssueNumber = Exclude<OrchestratorAction, { type: "start-implementation" }> extends infer A
    ? A extends { issueNumber: number | undefined }
      ? Omit<A, "issueNumber">
      : never
    : never;

  function withIssueNumber<T extends ActionWithoutIssueNumber>(
    action: T,
  ): T & { issueNumber: number | undefined } {
    return { ...action, issueNumber: actionIssueNumber };
  }

  // Merge conflicts take priority over the normal review/merge flow. We ask
  // Copilot to resolve them before proceeding; once the head SHA changes
  // (Copilot pushed a resolution) the resolve-conflicts session completes and
  // the normal flow resumes on the next iteration.
  if (pullRequest.hasMergeConflicts) {
    const reassignCopilot = shouldReassignCopilotForPhase(
      relevantSessions,
      "resolve-conflicts",
    );
    return withIssueNumber({
      type: "resolve-conflicts",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
      ...(reassignCopilot ? { reassignCopilot: true } : {}),
    });
  }

  // Authoritative GraphQL signal: the Copilot review bot has already
  // submitted a clean review on the current head SHA (no comments, no changes
  // requested). The PR is ready to merge — never re-request a review, just
  // advance to the final-description / merge lane. This short-circuits the
  // request-review fallbacks below and prevents the loop where each
  // iteration re-asks Copilot to review a PR it has already approved.
  if (
    pullRequest.hasCleanCopilotReviewOnHead &&
    latestCompletedSession?.phase !== "final-description"
  ) {
    return withIssueNumber({
      type: "write-final-description",
      pullRequestNumber: pullRequest.number,
      pullRequestTitle: pullRequest.title,
      pullRequestHeadRefName: pullRequest.headRefName,
      closingIssueNumbers: [...pullRequest.closingIssueNumbers],
      pullRequestBody: pullRequest.body,
    });
  }

  if (latestCompletedSession?.phase === "review") {
    const reviewCommentCount = latestCompletedSession.result?.reviewCommentCount ?? 0;
    if (reviewCommentCount > 0) {
      const reassignCopilot = shouldReassignCopilotForPhase(
        relevantSessions,
        "address-review-comments",
      );
      return withIssueNumber({
        type: "address-review-comments",
        pullRequestNumber: pullRequest.number,
        pullRequestHeadSha: pullRequest.headSha,
        reviewCommentCount,
        ...(reassignCopilot ? { reassignCopilot: true } : {}),
      });
    }

    return withIssueNumber({
      type: "write-final-description",
      pullRequestNumber: pullRequest.number,
      pullRequestTitle: pullRequest.title,
      pullRequestHeadRefName: pullRequest.headRefName,
      closingIssueNumbers: [...pullRequest.closingIssueNumbers],
      pullRequestBody: pullRequest.body,
    });
  }

  if (latestCompletedSession?.phase === "final-description") {
    const generatedDescription = latestCompletedSession.result?.generatedDescription;
    if (generatedDescription === undefined) {
      return withIssueNumber({
        type: "write-final-description",
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestHeadRefName: pullRequest.headRefName,
        closingIssueNumbers: [...pullRequest.closingIssueNumbers],
        pullRequestBody: pullRequest.body,
      });
    }

    if (pullRequest.draft) {
      return undefined;
    }

    return withIssueNumber({
      type: "merge-pull-request",
      closingIssueNumbers: [...pullRequest.closingIssueNumbers],
      pullRequestNumber: pullRequest.number,
      pullRequestBody: buildMergedPullRequestBody(
        pullRequest.body,
        pullRequest.closingIssueNumbers,
        generatedDescription,
      ),
    });
  }

  if (latestCompletedSession?.phase === "address-review-comments") {
    return withIssueNumber({
      type: "request-review",
      pullRequestNumber: pullRequest.number,
      resolveReviewThreads: true,
      ...(shouldResetDraftStateBeforeReview ? { resetDraftState: true } : {}),
    });
  }

  if (latestCompletedSession?.phase === "resolve-conflicts") {
    // Conflicts were resolved and Copilot pushed new code — start a fresh review.
    return withIssueNumber({
      type: "request-review",
      pullRequestNumber: pullRequest.number,
      ...(shouldResetDraftStateBeforeReview ? { resetDraftState: true } : {}),
    });
  }

  if (latestCompletedSession?.phase === "implementation") {
    return withIssueNumber({
      type: "request-review",
      pullRequestNumber: pullRequest.number,
      ...(shouldResetDraftStateBeforeReview ? { resetDraftState: true } : {}),
    });
  }

  if (!latestCompletedSession) {
    // No prior session has touched this PR — kick off a Copilot review. Draft
    // PRs are still eligible: drafts opened by the coding agent need the
    // initial review pass before they're ready to mark non-draft.
    return withIssueNumber({
      type: "request-review",
      pullRequestNumber: pullRequest.number,
      ...(shouldResetDraftStateBeforeReview ? { resetDraftState: true } : {}),
    });
  }

  return undefined;
}

function countImplementationSessionsWithoutPullRequests(
  agentSessions: AgentSession[],
  openIssueNumbers: ReadonlySet<number>,
  pullRequestIndex: Map<number, PullRequest>,
): number {
  const issueNumbers = new Set<number>();
  for (const session of agentSessions) {
    if (
      session.phase === "implementation" &&
      isActiveSession(session) &&
      session.issueNumber !== undefined &&
      openIssueNumbers.has(session.issueNumber) &&
      !pullRequestIndex.has(session.issueNumber)
    ) {
      issueNumbers.add(session.issueNumber);
    }
  }

  return issueNumbers.size;
}

export function buildMergedPullRequestBody(
  pullRequestBody: string,
  closingIssueNumbers: readonly number[],
  generatedDescription?: string,
): string {
  const baseBody = (generatedDescription ?? pullRequestBody).trim();
  const existingClosingIssues = new Set(parseClosingIssueNumbers(baseBody));
  const missingClosingReferences = uniqueSorted(closingIssueNumbers)
    .filter((issueNumber) => !existingClosingIssues.has(issueNumber))
    .map((issueNumber) => `Closes #${issueNumber}`);

  return [baseBody, ...missingClosingReferences].filter(Boolean).join("\n\n");
}

export function buildPlan(
  snapshot: RepositorySnapshot,
  maxConcurrency = 3,
): OrchestratorPlan {
  const issues = sortByCreatedAt(snapshot.issues.filter((issue) => issue.state === "open"));
  const pullRequests = sortByCreatedAt(
    snapshot.pullRequests.filter((pullRequest) => pullRequest.state === "open"),
  );
  const blockedIssueIndex = buildBlockedIssueIndex(issues);
  const pullRequestIndex = buildPullRequestIndex(pullRequests);

  const actions: OrchestratorAction[] = [];
  for (const pullRequest of pullRequests) {
    const action = planPullRequestAction(
      pullRequest,
      pullRequest.linkedIssueNumbers,
      snapshot.agentSessions,
    );
    if (action) {
      actions.push(action);
    }
  }

  const activePullRequestCount = pullRequests.length;
  const openIssueNumbers = new Set(issues.map((issue) => issue.number));
  const implementationSessionsWithoutPullRequests = countImplementationSessionsWithoutPullRequests(
    snapshot.agentSessions,
    openIssueNumbers,
    pullRequestIndex,
  );
  const remainingCapacity = Math.max(
    0,
    maxConcurrency - activePullRequestCount - implementationSessionsWithoutPullRequests,
  );

  if (remainingCapacity === 0) {
    return { actions, blockedIssueNumbers: blockedIssueIndex };
  }

  const unavailableIssueNumbers = new Set<number>();
  for (const pullRequest of pullRequests) {
    for (const issueNumber of pullRequest.linkedIssueNumbers) {
      unavailableIssueNumbers.add(issueNumber);
    }
  }

  for (const session of snapshot.agentSessions) {
    if (isActiveSession(session) && session.issueNumber !== undefined) {
      unavailableIssueNumbers.add(session.issueNumber);
    }
  }

  const eligibleIssues = issues.filter((issue) => {
    if (unavailableIssueNumbers.has(issue.number)) {
      return false;
    }

    const blockers = blockedIssueIndex[issue.number] ?? [];
    return blockers.every((blocker) => !openIssueNumbers.has(blocker));
  });

  // Prioritize bugs ahead of other issue types. GitHub's native issue Type
  // (distinct from labels) is the authoritative signal — an unblocked open
  // bug should always be picked before any feature/task/chore work,
  // regardless of which was filed first. Within the same priority bucket the
  // existing createdAt ordering is preserved (oldest first).
  const prioritizedEligibleIssues = [...eligibleIssues].sort(
    (left, right) => issuePriority(left) - issuePriority(right),
  );

  for (const issue of prioritizedEligibleIssues.slice(0, remainingCapacity)) {
    const reassignCopilot = shouldReassignCopilotForPhase(
      snapshot.agentSessions.filter((session) => session.issueNumber === issue.number),
      "implementation",
    );
    actions.push({
      type: "start-implementation",
      issueNumber: issue.number,
      ...(reassignCopilot ? { reassignCopilot: true } : {}),
    });
  }

  return { actions, blockedIssueNumbers: blockedIssueIndex };
}
