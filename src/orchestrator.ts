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

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sortByCreatedAt<T extends { createdAt: string; number: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return timeDifference === 0 ? left.number - right.number : timeDifference;
  });
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
        issueNumberSet.has(session.issueNumber) ||
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
  const issueNumber = issueNumbers[0];
  if (issueNumber === undefined) {
    // Defensively ignore PRs without linked issues even if callers already filter them out.
    return undefined;
  }

  const relevantSessions = getRelevantSessions(agentSessions, issueNumbers, pullRequest.number);
  if (relevantSessions.some(isActiveSession)) {
    return undefined;
  }

  const latestCompletedSession = getLatestCompletedSession(relevantSessions);
  const completedSessionIssueNumber = latestCompletedSession?.issueNumber;
  // Keep PR-level work attached to the issue that most recently advanced this PR when possible.
  const actionIssueNumber =
    completedSessionIssueNumber !== undefined &&
    issueNumbers.includes(completedSessionIssueNumber)
      ? completedSessionIssueNumber
      : issueNumber;
  if (latestCompletedSession?.phase === "review") {
    const reviewCommentCount = latestCompletedSession.result?.reviewCommentCount ?? 0;
    if (reviewCommentCount > 0) {
      return {
        type: "address-review-comments",
        issueNumber: actionIssueNumber,
        pullRequestNumber: pullRequest.number,
        reviewCommentCount,
      };
    }

    return {
      type: "write-final-description",
      issueNumber: actionIssueNumber,
      pullRequestNumber: pullRequest.number,
      closingIssueNumbers: [...pullRequest.closingIssueNumbers],
    };
  }

  if (latestCompletedSession?.phase === "final-description") {
    const generatedDescription = latestCompletedSession.result?.generatedDescription;
    if (generatedDescription === undefined) {
      return {
        type: "write-final-description",
        issueNumber: actionIssueNumber,
        pullRequestNumber: pullRequest.number,
        closingIssueNumbers: [...pullRequest.closingIssueNumbers],
      };
    }

    return {
      type: "merge-pull-request",
      issueNumber: actionIssueNumber,
      closingIssueNumbers: [...pullRequest.closingIssueNumbers],
      pullRequestNumber: pullRequest.number,
      pullRequestBody: buildMergedPullRequestBody(
        pullRequest.body,
        pullRequest.closingIssueNumbers,
        generatedDescription,
      ),
    };
  }

  if (latestCompletedSession?.phase === "address-review-comments") {
    return {
      type: "request-review",
      issueNumber: actionIssueNumber,
      pullRequestNumber: pullRequest.number,
      resolveReviewThreads: true,
    };
  }

  if (latestCompletedSession?.phase === "implementation") {
    return {
      type: "request-review",
      issueNumber: actionIssueNumber,
      pullRequestNumber: pullRequest.number,
    };
  }

  if (!latestCompletedSession && !pullRequest.draft) {
    return {
      type: "request-review",
      issueNumber,
      pullRequestNumber: pullRequest.number,
    };
  }

  return undefined;
}

function countImplementationSessionsWithoutPullRequests(
  agentSessions: AgentSession[],
  pullRequestIndex: Map<number, PullRequest>,
): number {
  const issueNumbers = new Set<number>();
  for (const session of agentSessions) {
    if (
      session.phase === "implementation" &&
      isActiveSession(session) &&
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
    if (pullRequest.linkedIssueNumbers.length === 0) {
      continue;
    }

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
  const implementationSessionsWithoutPullRequests = countImplementationSessionsWithoutPullRequests(
    snapshot.agentSessions,
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
    if (isActiveSession(session)) {
      unavailableIssueNumbers.add(session.issueNumber);
    }
  }

  const openIssueNumbers = new Set(issues.map((issue) => issue.number));
  const eligibleIssues = issues.filter((issue) => {
    if (unavailableIssueNumbers.has(issue.number)) {
      return false;
    }

    const blockers = blockedIssueIndex[issue.number] ?? [];
    return blockers.every((blocker) => !openIssueNumbers.has(blocker));
  });

  for (const issue of eligibleIssues.slice(0, remainingCapacity)) {
    actions.push({ type: "start-implementation", issueNumber: issue.number });
  }

  return { actions, blockedIssueNumbers: blockedIssueIndex };
}
