import type {
  AgentSession,
  Issue,
  OrchestratorAction,
  OrchestratorPlan,
  PullRequest,
  RepositorySnapshot,
} from "./types.js";

/** Maximum time to wait for CI checks to complete before treating them as failed. */
export const CHECKS_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Configuration for Human-in-the-Loop project mode.
 * When provided to `buildPlan`, vibrator filters issues by project status,
 * skips issues labelled "manual", never auto-merges, and instead requests
 * human review after self-review passes.
 */
export interface ProjectModeConfig {
  projectNumber: number;
  /** GitHub login(s) to request review from when work is ready. */
  reviewers: string[];
}

const BLOCKED_BY_PATTERN = /\b(?:blocked by|depends on)\s*:?\s*#(\d+)\b/gi;
const BLOCKS_PATTERN = /\bblocks\s*:?\s*#(\d+)\b/gi;
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

/**
 * Returns the number of the earliest milestone that still has open issues,
 * or undefined if no issues have a milestone assigned.
 */
export function selectEarliestMilestoneNumber(issues: Issue[]): number | undefined {
  let earliest: number | undefined;
  for (const issue of issues) {
    if (issue.milestone !== undefined) {
      if (earliest === undefined || issue.milestone.number < earliest) {
        earliest = issue.milestone.number;
      }
    }
  }
  return earliest;
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

    // Parent/child relationship: a parent issue is blocked by each of its
    // open children. If this issue is a sub-issue, its parent cannot start
    // until this issue is resolved.
    if (issue.parentNumber !== undefined) {
      const parentBlockers = blockedIssueIndex.get(issue.parentNumber) ?? new Set<number>();
      parentBlockers.add(issue.number);
      blockedIssueIndex.set(issue.parentNumber, parentBlockers);
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
  projectMode?: ProjectModeConfig,
  issueProjectStatuses?: ReadonlyMap<number, string>,
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

  // Merge conflicts take priority over the normal self-review/merge flow.
  if (pullRequest.hasMergeConflicts) {
    return withIssueNumber({
      type: "resolve-conflicts",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  // Status-check gate: never advance to merge while checks are failing or
  // still running; also block self-review after code-changing phases.
  const mergeGateAction = ((): OrchestratorAction | undefined | "proceed" => {
    if (pullRequest.checksStatus === "failure") {
      return withIssueNumber({
        type: "address-failing-checks",
        pullRequestNumber: pullRequest.number,
        pullRequestHeadSha: pullRequest.headSha,
      });
    }
    if (pullRequest.checksStatus === "pending") {
      // If the commit has been pushed longer than the timeout threshold,
      // treat the stuck checks as a failure so Claude can investigate.
      const pushedAt = pullRequest.headCommitPushedAt;
      if (pushedAt !== undefined && Date.now() - Date.parse(pushedAt) > CHECKS_TIMEOUT_MS) {
        return withIssueNumber({
          type: "address-failing-checks",
          pullRequestNumber: pullRequest.number,
          pullRequestHeadSha: pullRequest.headSha,
        });
      }
      return undefined;
    }
    return "proceed";
  })();

  if (latestCompletedSession?.phase === "squash-merge") {
    // The squash merge has been completed — nothing left to do.
    // (The PR will disappear from listOpenPullRequests on the next iteration.)
    return undefined;
  }

  // In project mode, handle re-queue conditions after human review was requested.
  if (projectMode && latestCompletedSession?.phase === "request-review") {
    // PR converted to draft → human wants more work done.
    const needsWork =
      pullRequest.draft ||
      pullRequest.hasNewCommentsSinceLastRead ||
      // Issue moved back to "Ready" in the project board.
      (actionIssueNumber !== undefined &&
        issueProjectStatuses?.get(actionIssueNumber)?.toLowerCase() === "ready");

    if (!needsWork) {
      // Waiting for human review — nothing to do this iteration.
      return undefined;
    }
    if (mergeGateAction !== "proceed") {
      return mergeGateAction;
    }
    return withIssueNumber({
      type: "self-review",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  // After a code-changing phase, check CI before the next self-review.
  if (
    latestCompletedSession?.phase === "implementation" ||
    latestCompletedSession?.phase === "address-failing-checks" ||
    latestCompletedSession?.phase === "resolve-conflicts"
  ) {
    if (mergeGateAction !== "proceed") {
      return mergeGateAction;
    }
    return withIssueNumber({
      type: "self-review",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  if (latestCompletedSession?.phase === "self-review") {
    if (latestCompletedSession.result?.madeChanges) {
      // Self-review pushed new commits — check CI before the next pass.
      if (mergeGateAction !== "proceed") {
        return mergeGateAction;
      }
      return withIssueNumber({
        type: "self-review",
        pullRequestNumber: pullRequest.number,
        pullRequestHeadSha: pullRequest.headSha,
      });
    }

    // Clean self-review. In project mode, one clean pass → request human review
    // (never auto-merge).
    if (projectMode) {
      if (mergeGateAction !== "proceed") {
        return mergeGateAction;
      }
      return withIssueNumber({
        type: "request-review",
        pullRequestNumber: pullRequest.number,
        reviewers: projectMode.reviewers,
      });
    }

    // Non-project mode: check if the immediately preceding completed session
    // was also a clean self-review. Two consecutive clean passes → squash-merge.
    const completedBeforeLatest = relevantSessions
      .filter((s) => s.status === "completed" && s.id !== latestCompletedSession.id)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const penultimate = completedBeforeLatest[0];
    if (penultimate?.phase === "self-review" && !penultimate.result?.madeChanges) {
      if (mergeGateAction !== "proceed") {
        return mergeGateAction;
      }
      return withIssueNumber({
        type: "squash-merge",
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestHeadRefName: pullRequest.headRefName,
        closingIssueNumbers: [...pullRequest.closingIssueNumbers],
        pullRequestBody: pullRequest.body,
      });
    }

    // Only one clean pass so far — run another self-review immediately.
    // No CI gate here: no new commits were pushed by the clean review, so
    // there is nothing new for CI to test. The merge step below still gates
    // on CI passing before squash-merging.
    return withIssueNumber({
      type: "self-review",
      pullRequestNumber: pullRequest.number,
      pullRequestHeadSha: pullRequest.headSha,
    });
  }

  // No prior session (or an unrecognized legacy phase): run the first
  // self-review, waiting for CI first.
  if (mergeGateAction !== "proceed") {
    return mergeGateAction;
  }
  return withIssueNumber({
    type: "self-review",
    pullRequestNumber: pullRequest.number,
    pullRequestHeadSha: pullRequest.headSha,
  });
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
): string {
  const baseBody = pullRequestBody.trim();
  const existingClosingIssues = new Set(parseClosingIssueNumbers(baseBody));
  const missingClosingReferences = uniqueSorted(closingIssueNumbers)
    .filter((issueNumber) => !existingClosingIssues.has(issueNumber))
    .map((issueNumber) => `Closes #${issueNumber}`);

  return [baseBody, ...missingClosingReferences].filter(Boolean).join("\n\n");
}

export function buildPlan(
  snapshot: RepositorySnapshot,
  maxConcurrency = 3,
  projectMode?: ProjectModeConfig,
): OrchestratorPlan {
  const issues = sortByCreatedAt(snapshot.issues.filter((issue) => issue.state === "open"));
  const pullRequests = sortByCreatedAt(
    snapshot.pullRequests.filter((pullRequest) => pullRequest.state === "open"),
  );
  const openIssueNumbers = new Set(issues.map((issue) => issue.number));
  const blockedIssueIndex = buildBlockedIssueIndex(issues);

  // Only expose open blockers to the dashboard — a closed issue no longer blocks anything.
  const blockedIssueNumbers: Record<number, number[]> = {};
  for (const [issueNum, blockers] of Object.entries(blockedIssueIndex)) {
    const openBlockers = blockers.filter((b) => openIssueNumbers.has(b));
    if (openBlockers.length > 0) {
      blockedIssueNumbers[Number(issueNum)] = openBlockers;
    }
  }

  const pullRequestIndex = buildPullRequestIndex(pullRequests);

  // Build a map of issue number → project status for use in planPullRequestAction.
  const issueProjectStatuses = new Map(
    issues
      .filter((i) => i.projectStatus !== undefined)
      .map((i) => [i.number, i.projectStatus!]),
  );

  const actions: OrchestratorAction[] = [];
  // Count only PRs that still occupy an engine cylinder. A PR with an active
  // session or a planned orchestrator action is live work; a PR parked
  // awaiting human review (ready-for-review, post `request-review` with no
  // re-queue signal) or already squash-merged needs no cylinder time. If
  // those parked PRs are counted against `maxConcurrency` they starve new
  // issues of capacity and leave cylinders idle — which is exactly the bug
  // where three PRs ready-for-review froze all three cylinders.
  let livePullRequestCount = 0;
  for (const pullRequest of pullRequests) {
    const hasActiveSession = getRelevantSessions(
      snapshot.agentSessions,
      pullRequest.linkedIssueNumbers,
      pullRequest.number,
    ).some(isActiveSession);
    const action = planPullRequestAction(
      pullRequest,
      pullRequest.linkedIssueNumbers,
      snapshot.agentSessions,
      projectMode,
      issueProjectStatuses,
    );
    if (action) {
      actions.push(action);
    }
    if (action || hasActiveSession) {
      livePullRequestCount += 1;
    }
  }

  const implementationSessionsWithoutPullRequests = countImplementationSessionsWithoutPullRequests(
    snapshot.agentSessions,
    openIssueNumbers,
    pullRequestIndex,
  );
  const remainingCapacity = Math.max(
    0,
    maxConcurrency - livePullRequestCount - implementationSessionsWithoutPullRequests,
  );

  if (remainingCapacity === 0) {
    return { actions, blockedIssueNumbers };
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

  // Milestone gate: an issue in milestone N can start only once every issue
  // in milestones < N has either been completed (closed, so absent from the
  // open-issues list) or at least started (has an open linked PR or an
  // active agent session, i.e. is in `unavailableIssueNumbers`). Find the
  // earliest milestone that still contains an unstarted open issue — that is
  // the only milestone whose issues are eligible to start now. Issues
  // without a milestone are unaffected.
  const unstartedIssues = issues.filter(
    (issue) => !unavailableIssueNumbers.has(issue.number),
  );
  const earliestUnstartedMilestoneNumber = selectEarliestMilestoneNumber(unstartedIssues);

  const eligibleIssues = issues.filter((issue) => {
    if (unavailableIssueNumbers.has(issue.number)) {
      return false;
    }

    // Issues labelled "manual" are never picked up automatically.
    if (issue.labels.includes("manual")) {
      return false;
    }

    // In project mode, only pick up issues that are in "Ready" state.
    if (projectMode && issue.projectStatus?.toLowerCase() !== "ready") {
      return false;
    }

    const blockers = blockedIssueIndex[issue.number] ?? [];
    if (!blockers.every((blocker) => !openIssueNumbers.has(blocker))) {
      return false;
    }

    if (earliestUnstartedMilestoneNumber !== undefined && issue.milestone !== undefined) {
      return issue.milestone.number === earliestUnstartedMilestoneNumber;
    }

    return true;
  });

  // Prioritize bugs ahead of other types.
  const prioritizedEligibleIssues = [...eligibleIssues].sort(
    (left, right) => issuePriority(left) - issuePriority(right),
  );

  for (const issue of prioritizedEligibleIssues.slice(0, remainingCapacity)) {
    actions.push({ type: "start-implementation", issueNumber: issue.number });
  }

  return { actions, blockedIssueNumbers };
}
