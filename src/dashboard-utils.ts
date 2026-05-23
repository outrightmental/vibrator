import { globalEventEmitter } from "./event-emitter.js";
import type { RepositorySnapshot, PullRequest, Issue, Commit } from "./types.js";

// Issues labelled "manual" are intentionally hidden from the dashboard; the
// orchestrator also refuses to pick them up automatically.
function isManualIssue(issue: Issue): boolean {
  return issue.labels.includes("manual");
}

const PROJECT_LIFECYCLE_VISIBLE_STATUSES = new Set(["ready", "in progress", "in review"]);

function isProjectLifecycleVisibleIssue(issue: Issue): boolean {
  const status = issue.projectStatus?.trim().toLowerCase();
  return status !== undefined && PROJECT_LIFECYCLE_VISIBLE_STATUSES.has(status);
}

// PRs labelled "manual" are never worked on automatically. They still appear
// on the dashboard paired with their (non-manual) issue, but rendered disabled.
function isManualPullRequest(pr: PullRequest): boolean {
  return pr.labels.includes("manual");
}

export interface LifecyclePair {
  /**
   * The issue this PR closes, or null for an orphan PR — a PR not connected to
   * any issue. Orphan-PR pairs render as a whole pill with an empty left half.
   */
  issue: { number: number; title: string; state: string } | null;
  pr: { number: number; title: string; state: string; draft: boolean; checksStatus: string } | null;
  /** absent=no PR, planning=implementation in plan, active=draft PR open, review=non-draft PR open, completed=PR closed */
  prPhase: "absent" | "planning" | "active" | "review" | "completed";
  /** Stable color slot index (issue.number % palette length) */
  colorIndex: number;
  /** Issue numbers blocking this issue, if any (populated for pre-implementation issues) */
  blockedByIssueNumbers?: number[];
  /**
   * True when the PR is labelled "manual" — vibrator will not work on it, so
   * the PR half is rendered disabled (greyed out, no glow).
   */
  disabled?: boolean;
}

function phaseSortPriority(phase: string, isBlocked: boolean): number {
  // review (needs human attention) first, then draft active, then completed,
  // then planning, then unblocked-absent, then blocked-absent.
  if (phase === "review") return 0;
  if (phase === "active") return 1;
  if (phase === "completed") return 2;
  if (phase === "planning") return 3;
  if (phase === "absent" && !isBlocked) return 4;
  return 5; // absent && blocked
}

export function broadcastLifecycleUpdate(
  snapshot: RepositorySnapshot,
  planningIssueNumbers: ReadonlySet<number> = new Set(),
  completedIssueNumbers: ReadonlySet<number> = new Set(),
  blockedIssueNumbers: Readonly<Record<number, number[]>> = {},
  projectModeEnabled = false,
): void {
  const pairs: LifecyclePair[] = [];
  const pairedIssueNumbers = new Set<number>();
  const visibleIssues = snapshot.issues.filter(
    (i) => !isManualIssue(i) && (!projectModeEnabled || isProjectLifecycleVisibleIssue(i)),
  );

  // Pair each open PR with its closing issues (falling back to linked issues)
  for (const pr of snapshot.pullRequests) {
    const issueNums =
      pr.closingIssueNumbers.length > 0 ? pr.closingIssueNumbers : pr.linkedIssueNumbers;
    for (const issueNumber of issueNums) {
      if (pairedIssueNumbers.has(issueNumber)) continue;
      const issue = visibleIssues.find((i) => i.number === issueNumber);
      if (!issue) continue;
      pairedIssueNumbers.add(issueNumber);
      pairs.push({
        issue: { number: issue.number, title: issue.title, state: issue.state },
        pr: {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          checksStatus: pr.checksStatus,
        },
        prPhase: completedIssueNumbers.has(issueNumber) ? "completed" : pr.draft ? "active" : "review",
        colorIndex: issue.number % 6,
        ...(blockedIssueNumbers[issue.number] !== undefined && {
          blockedByIssueNumbers: blockedIssueNumbers[issue.number],
        }),
        ...(isManualPullRequest(pr) && { disabled: true }),
      });
    }
  }

  // Orphan PRs — open PRs not connected to any issue (no closing or linked
  // issue numbers). They render as a whole pill with an empty left half and
  // the PR in the right half.
  for (const pr of snapshot.pullRequests) {
    if (pr.state !== "open") continue;
    if (pr.closingIssueNumbers.length > 0 || pr.linkedIssueNumbers.length > 0) continue;
    pairs.push({
      issue: null,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        checksStatus: pr.checksStatus,
      },
      prPhase: pr.draft ? "active" : "review",
      colorIndex: pr.number % 6,
      ...(isManualPullRequest(pr) && { disabled: true }),
    });
  }

  // Issues not yet paired get an absent or planning right half
  for (const issue of visibleIssues) {
    if (pairedIssueNumbers.has(issue.number)) continue;
    pairs.push({
      issue: { number: issue.number, title: issue.title, state: issue.state },
      pr: null,
      prPhase: planningIssueNumbers.has(issue.number) ? "planning" : "absent",
      colorIndex: issue.number % 6,
      ...(blockedIssueNumbers[issue.number] !== undefined && {
        blockedByIssueNumbers: blockedIssueNumbers[issue.number],
      }),
    });
  }

  // Display order: active → completed → planning → unblocked absent → blocked absent.
  // PR-bearing rows always above non-PR rows; planning above fully-unimplemented.
  // Within each group, ascending issue number (client may override with cylinder order).
  pairs.sort((a, b) => {
    const aBlocked = (a.blockedByIssueNumbers?.length ?? 0) > 0;
    const bBlocked = (b.blockedByIssueNumbers?.length ?? 0) > 0;
    const aPriority = phaseSortPriority(a.prPhase, aBlocked);
    const bPriority = phaseSortPriority(b.prPhase, bBlocked);
    if (aPriority !== bPriority) return aPriority - bPriority;
    // Orphan PRs (no issue) sort by PR number within their tier.
    const aNum = a.issue ? a.issue.number : a.pr!.number;
    const bNum = b.issue ? b.issue.number : b.pr!.number;
    return aNum - bNum;
  });

  globalEventEmitter.emit("lifecycle-update", { pairs });
}

export function broadcastRepositorySnapshot(
  snapshot: RepositorySnapshot,
  owner: string,
  repo: string,
  overrideSessionCount?: number,
): void {
  const openPRs = snapshot.pullRequests.filter((pr) => pr.state === "open");
  const draftPRs = openPRs.filter((pr) => pr.draft);
  const readyPRs = openPRs.filter((pr) => !pr.draft);
  const visibleIssues = snapshot.issues.filter((i) => !isManualIssue(i));

  const checkStats = {
    success: readyPRs.filter((pr) => pr.checksStatus === "success").length,
    failure: readyPRs.filter((pr) => pr.checksStatus === "failure").length,
    pending: readyPRs.filter((pr) => pr.checksStatus === "pending").length,
  };

  const activeSessionCount = overrideSessionCount ?? snapshot.agentSessions.filter((s) => s.status === "in_progress").length;

  const stateAfter = `${visibleIssues.length} issues open | ${readyPRs.length} ready PRs | ${activeSessionCount} active sessions | CI: ${checkStats.success}✅ ${checkStats.failure}❌ ${checkStats.pending}⏳`;

  const excellence = checkStats.failure === 0 && checkStats.success > 0
    ? `All ${checkStats.success} CI check(s) green — PRs in great shape`
    : checkStats.failure > 0
    ? `${checkStats.failure} failing CI check(s) identified — agent will remediate`
    : "Full repository visibility maintained across all active work";

  globalEventEmitter.emit("broadcast-github-activity", {
    content: `Repository snapshot: ${visibleIssues.length} open issues, ${openPRs.length} PRs (${draftPRs.length} draft, ${readyPRs.length} ready), ${activeSessionCount} active sessions, checks: ${checkStats.success} success, ${checkStats.failure} failed, ${checkStats.pending} pending`,
    repo: `${owner}/${repo}`,
    issueCount: visibleIssues.length,
    prCount: openPRs.length,
    draftCount: draftPRs.length,
    readyCount: readyPRs.length,
    sessionCount: activeSessionCount,
    checkStats,
    stateBefore: `${owner}/${repo} — prior scan`,
    changeHow: `Automated repository scan completed`,
    stateAfter,
    excellence,
  });
}

export function broadcastPullRequestUpdate(pr: PullRequest, action: string, workerIndex?: number): void {
  const statusEmoji = pr.draft ? "📝" : "✨";
  const checksEmoji =
    pr.checksStatus === "success"
      ? "✅"
      : pr.checksStatus === "failure"
        ? "❌"
        : pr.checksStatus === "pending"
          ? "⏳"
          : "⚪";

  const draftLabel = pr.draft ? "draft" : "ready";
  const checksLabel = pr.checksStatus === "success" ? "CI passing" :
    pr.checksStatus === "failure" ? "CI failing" :
    pr.checksStatus === "pending" ? "CI pending" : "no CI";

  let stateBefore: string;
  let changeHow: string;
  let stateAfter: string;
  let excellence: string;

  if (action.includes("monitoring") || action.includes("tracking")) {
    stateBefore = `PR #${pr.number} "${pr.title}" — ${draftLabel}`;
    changeHow = `Continuous monitoring: ${action}`;
    stateAfter = `${pr.state.toUpperCase()} ${statusEmoji} — ${checksLabel}`;
    excellence = pr.checksStatus === "success" && !pr.draft
      ? "CI green and not draft — prime merge candidate!"
      : pr.hasMergeConflicts
      ? "Merge conflicts detected — agent will resolve"
      : pr.unresolvedReviewCommentCount > 0
      ? `${pr.unresolvedReviewCommentCount} review comment(s) will be addressed`
      : "Development advancing steadily";
  } else {
    stateBefore = `PR #${pr.number} "${pr.title}" — ${draftLabel}, ${checksLabel}`;
    changeHow = action;
    stateAfter = `${pr.state.toUpperCase()} ${statusEmoji} [${pr.checksStatus.toUpperCase()} ${checksEmoji}]`;
    excellence = pr.hasCleanReviewOnHead
      ? "Clean review — code quality validated, ready to advance"
      : pr.checksStatus === "success" && !pr.draft
      ? "CI passing — ready to merge!"
      : "Active iteration — getting closer to done";
  }

  globalEventEmitter.emit("broadcast-pr-update", {
    content: `PR #${pr.number} "${pr.title}" - ${action} ${statusEmoji} [${pr.state.toUpperCase()} ${checksEmoji}]`,
    prNumber: pr.number,
    title: pr.title,
    action,
    state: pr.state,
    draft: pr.draft,
    checksStatus: pr.checksStatus,
    stateBefore,
    changeHow,
    stateAfter,
    excellence,
    workerIndex,
  });
}

export function broadcastCIStatus(prNumber: number, status: string, details?: string, workerIndex?: number): void {
  const statusEmoji =
    status === "success" ? "✅" : status === "failure" ? "❌" : status === "pending" ? "⏳" : "⚪";

  const content = details
    ? `PR #${prNumber} CI ${status.toUpperCase()} - ${details}`
    : `PR #${prNumber} CI ${status.toUpperCase()}`;

  const statusMap: Record<string, { before: string; after: string; excellence: string }> = {
    success: {
      before: `PR #${prNumber} CI checks were pending or unknown`,
      after: `${statusEmoji} All checks PASSED for PR #${prNumber}`,
      excellence: "Quality gate cleared — this PR is merge-ready!",
    },
    failure: {
      before: `PR #${prNumber} CI checks were passing or pending`,
      after: `${statusEmoji} Checks FAILED: ${details || `PR #${prNumber}`}`,
      excellence: "Failure caught early — agent will diagnose and fix immediately",
    },
    pending: {
      before: `PR #${prNumber} had no running CI checks`,
      after: `${statusEmoji} Checks now RUNNING for PR #${prNumber}`,
      excellence: "Pipeline active — validation in progress, quality assured",
    },
  };

  const msg = statusMap[status] ?? {
    before: `PR #${prNumber} had previous CI state`,
    after: `CI is now ${status.toUpperCase()} for PR #${prNumber}`,
    excellence: "CI state updated — system is actively monitored",
  };

  globalEventEmitter.emit("broadcast-ci-status", {
    content,
    prNumber,
    status,
    details,
    stateBefore: msg.before,
    changeHow: `CI pipeline executed${details ? `: ${details}` : ""}`,
    stateAfter: msg.after,
    excellence: msg.excellence,
    workerIndex,
  });
}

export function broadcastReviewComment(
  prNumber: number,
  author: string,
  commentCount: number,
  workerIndex?: number,
): void {
  globalEventEmitter.emit("broadcast-review-comment", {
    content: `Review from ${author} on PR #${prNumber}: ${commentCount} comment(s)`,
    prNumber,
    author,
    commentCount,
    stateBefore: `PR #${prNumber} had unreviewed code`,
    changeHow: `${author} submitted review with ${commentCount} comment(s)`,
    stateAfter: `PR #${prNumber} has ${commentCount} review comment(s) to address`,
    excellence: "Feedback received — agent will address every comment to improve the code",
    workerIndex,
  });
}

export function broadcastIssueUpdate(issue: Issue, action: string, workerIndex?: number): void {
  if (isManualIssue(issue)) return;

  const stateEmoji = issue.state === "open" ? "🔴" : "🟢";

  const stateBefore = action === "opened"
    ? "Issue did not exist"
    : `Issue #${issue.number} "${issue.title}" was ${action === "closed" ? "open" : "in previous state"}`;

  const stateAfter = `${stateEmoji} Issue #${issue.number} is ${issue.state.toUpperCase()}: "${issue.title}"`;

  const excellence = issue.state === "closed"
    ? "Issue resolved and closed — goal achieved! One step closer to a perfect repo."
    : action === "opened"
    ? "New work item queued — will be implemented automatically by the agent"
    : "Issue actively tracked — progress is being made";

  globalEventEmitter.emit("broadcast-issue-update", {
    content: `Issue #${issue.number} ${action} "${issue.title}" ${stateEmoji}`,
    issueNumber: issue.number,
    title: issue.title,
    action,
    state: issue.state,
    stateBefore,
    changeHow: `Issue ${action}: "${issue.title}"`,
    stateAfter,
    excellence,
    workerIndex,
  });
}

export function broadcastCommit(commit: Commit, workerIndex?: number): void {
  const shortHash = commit.hash.slice(0, 7);
  const firstLine = commit.message.split('\n')[0];
  globalEventEmitter.emit("broadcast-commit", {
    content: `Commit ${shortHash} by ${commit.author}: ${firstLine}`,
    hash: commit.hash,
    author: commit.author,
    message: firstLine,
    stateBefore: "Branch was at previous commit",
    changeHow: `${commit.author} pushed ${shortHash}`,
    stateAfter: `Branch advanced: "${firstLine}"`,
    excellence: "Continuous incremental progress — every commit brings the goal closer",
    workerIndex,
  });
}

export function emitLogMessage(level: "info" | "success" | "warning" | "error", message: string): void {
  globalEventEmitter.emit("log-message", {
    level,
    message,
  });
}

/** Returns true if the PR's observable state has changed relative to a prior snapshot version. */
export function hasPrStateChanged(current: PullRequest, last: PullRequest): boolean {
  return (
    current.state !== last.state ||
    current.draft !== last.draft ||
    current.checksStatus !== last.checksStatus ||
    current.hasMergeConflicts !== last.hasMergeConflicts ||
    current.unresolvedReviewCommentCount !== last.unresolvedReviewCommentCount
  );
}

/** Returns only the commits whose hash has not yet been recorded in seenHashes. */
export function filterNewCommits(commits: Commit[], seenHashes: ReadonlySet<string>): Commit[] {
  return commits.filter((c) => !seenHashes.has(c.hash));
}
