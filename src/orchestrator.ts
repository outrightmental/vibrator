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

const ACTIVE_STATUSES = new Set(["in_progress"]);

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
 * case-insensitively) jump ahead of every other type so an unblocked open
 * bug is always picked before any feature/task work.
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
    if (!capturedIssueNumber) continue;
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

  const latestCompletedSession = getLatestCompletedSession(relevantSessions);
  const completedSessionIssueNumber = latestCompletedSession?.issueNumber;
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

  // Merge conflicts take priority over the normal review/merge flow.
  if (pullRequest.hasMergeConflicts) {
    return withIssueNumber({
      type: "resolve-conflicts",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  // Status-check gate: never advance to final-description / merge while
  // checks are failing or still running.
  const mergeGateAction = ((): OrchestratorAction | undefined | "proceed" => {
    if (pullRequest.checksStatus === "failure") {
      return withIssueNumber({
        type: "address-failing-checks",
        pullRequestNumber: pullRequest.number,
        pullRequestHeadSha: pullRequest.headSha,
      });
    }
    if (pullRequest.checksStatus === "pending") {
      return undefined;
    }
    return "proceed";
  })();

  // After Claude pushed a fix for failing checks, re-review the updated code.
  if (latestCompletedSession?.phase === "address-failing-checks") {
    if (mergeGateAction !== "proceed") {
      return mergeGateAction;
    }
    return withIssueNumber({
      type: "review-pull-request",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  // Unresolved review comments must be addressed before any merge-path
  // action, regardless of what the latest session phase is.
  if (pullRequest.unresolvedReviewCommentCount > 0) {
    const reviewCommentCount =
      latestCompletedSession?.phase === "review"
        ? (latestCompletedSession.result?.reviewCommentCount ?? 0)
        : 0;
    return withIssueNumber({
      type: "address-review-comments",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
      unresolvedReviewCommentCount: Math.max(
        reviewCommentCount,
        pullRequest.unresolvedReviewCommentCount,
      ),
    });
  }

  if (latestCompletedSession?.phase === "review") {
    const reviewCommentCount = latestCompletedSession.result?.reviewCommentCount ?? 0;
    if (reviewCommentCount > 0) {
      return withIssueNumber({
        type: "address-review-comments",
        pullRequestNumber: pullRequest.number,
        pullRequestHeadSha: pullRequest.headSha,
        unresolvedReviewCommentCount: reviewCommentCount,
      });
    }

    // The review session recorded zero comments. Require confirmation
    // from GitHub as well: hasCleanReviewOnHead must be true so we
    // know the APPROVE review actually landed on the current head SHA.
    if (!pullRequest.hasCleanReviewOnHead) {
      // The review session said zero comments but GitHub doesn't see a
      // clean review on the head — re-review to reconcile.
      return withIssueNumber({
        type: "review-pull-request",
        pullRequestNumber: pullRequest.number,
        pullRequestHeadSha: pullRequest.headSha,
      });
    }

    if (mergeGateAction !== "proceed") {
      return mergeGateAction;
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
      if (mergeGateAction !== "proceed") {
        return mergeGateAction;
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

    // write-final-description completed with a description but merge
    // hasn't happened yet — emit the squash-merge action.
    return withIssueNumber({
      type: "squash-merge",
      pullRequestNumber: pullRequest.number,
      pullRequestTitle: pullRequest.title,
      closingIssueNumbers: [...pullRequest.closingIssueNumbers],
      pullRequestBody:
        latestCompletedSession.result?.pullRequestBody ?? pullRequest.body,
    });
  }

  if (latestCompletedSession?.phase === "squash-merge") {
    // The squash merge has been completed — nothing left to do.
    // (The PR will disappear from listOpenPullRequests on the next iteration.)
    return undefined;
  }

  // Clean review on the current head SHA with no prior review session
  // (e.g. an externally-posted clean review). Only advance to
  // final-description when both the GitHub-side flag AND our own
  // session history agree. If we have no session but see a clean
  // review, trust it and advance.
  if (pullRequest.hasCleanReviewOnHead && !latestCompletedSession) {
    if (mergeGateAction !== "proceed") {
      return mergeGateAction;
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

  if (latestCompletedSession?.phase === "address-review-comments") {
    return withIssueNumber({
      type: "review-pull-request",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  if (latestCompletedSession?.phase === "resolve-conflicts") {
    return withIssueNumber({
      type: "review-pull-request",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  if (latestCompletedSession?.phase === "implementation") {
    return withIssueNumber({
      type: "review-pull-request",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  if (!latestCompletedSession) {
    // No prior session has touched this PR — request the first review.
    return withIssueNumber({
      type: "review-pull-request",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
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

  // Prioritize bugs ahead of other types.
  const prioritizedEligibleIssues = [...eligibleIssues].sort(
    (left, right) => issuePriority(left) - issuePriority(right),
  );

  for (const issue of prioritizedEligibleIssues.slice(0, remainingCapacity)) {
    actions.push({ type: "start-implementation", issueNumber: issue.number });
  }

  return { actions, blockedIssueNumbers: blockedIssueIndex };
}
