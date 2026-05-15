import { globalEventEmitter } from "./event-emitter.js";
import type { RepositorySnapshot, PullRequest, Issue, Commit } from "./types.js";

export interface LifecyclePair {
  issue: { number: number; title: string; state: string };
  pr: { number: number; title: string; state: string; draft: boolean; checksStatus: string } | null;
  /** absent=no PR, planning=implementation in plan, active=PR open, completed=PR closed */
  prPhase: "absent" | "planning" | "active" | "completed";
  /** Stable color slot index (issue.number % palette length) */
  colorIndex: number;
}

export function broadcastLifecycleUpdate(
  snapshot: RepositorySnapshot,
  planningIssueNumbers: ReadonlySet<number> = new Set(),
  completedIssueNumbers: ReadonlySet<number> = new Set(),
): void {
  const pairs: LifecyclePair[] = [];
  const pairedIssueNumbers = new Set<number>();

  // Pair each open PR with its closing issues (falling back to linked issues)
  for (const pr of snapshot.pullRequests) {
    const issueNums =
      pr.closingIssueNumbers.length > 0 ? pr.closingIssueNumbers : pr.linkedIssueNumbers;
    for (const issueNumber of issueNums) {
      if (pairedIssueNumbers.has(issueNumber)) continue;
      const issue = snapshot.issues.find((i) => i.number === issueNumber);
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
        prPhase: completedIssueNumbers.has(issueNumber) ? "completed" : "active",
        colorIndex: issue.number % 6,
      });
    }
  }

  // Issues not yet paired get an absent or planning right half
  for (const issue of snapshot.issues) {
    if (pairedIssueNumbers.has(issue.number)) continue;
    pairs.push({
      issue: { number: issue.number, title: issue.title, state: issue.state },
      pr: null,
      prPhase: planningIssueNumbers.has(issue.number) ? "planning" : "absent",
      colorIndex: issue.number % 6,
    });
  }

  // Stable display order: ascending issue number
  pairs.sort((a, b) => a.issue.number - b.issue.number);

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

  const checkStats = {
    success: readyPRs.filter((pr) => pr.checksStatus === "success").length,
    failure: readyPRs.filter((pr) => pr.checksStatus === "failure").length,
    pending: readyPRs.filter((pr) => pr.checksStatus === "pending").length,
  };

  const activeSessionCount = overrideSessionCount ?? snapshot.agentSessions.filter((s) => s.status === "in_progress").length;

  globalEventEmitter.emit("broadcast-github-activity", {
    content: `Repository snapshot: ${snapshot.issues.length} open issues, ${openPRs.length} PRs (${draftPRs.length} draft, ${readyPRs.length} ready), ${activeSessionCount} active sessions, checks: ${checkStats.success} success, ${checkStats.failure} failed, ${checkStats.pending} pending`,
    repo: `${owner}/${repo}`,
    issueCount: snapshot.issues.length,
    prCount: openPRs.length,
    draftCount: draftPRs.length,
    readyCount: readyPRs.length,
    sessionCount: activeSessionCount,
    checkStats,
  });
}

export function broadcastPullRequestUpdate(pr: PullRequest, action: string): void {
  const statusEmoji = pr.draft ? "📝" : "✨";
  const checksEmoji =
    pr.checksStatus === "success"
      ? "✅"
      : pr.checksStatus === "failure"
        ? "❌"
        : pr.checksStatus === "pending"
          ? "⏳"
          : "⚪";

  globalEventEmitter.emit("broadcast-pr-update", {
    content: `PR #${pr.number} "${pr.title}" - ${action} ${statusEmoji} [${pr.state.toUpperCase()} ${checksEmoji}]`,
    prNumber: pr.number,
    title: pr.title,
    action,
    state: pr.state,
    draft: pr.draft,
    checksStatus: pr.checksStatus,
  });
}

export function broadcastCIStatus(prNumber: number, status: string, details?: string): void {
  const statusEmoji =
    status === "success" ? "✅" : status === "failure" ? "❌" : status === "pending" ? "⏳" : "⚪";

  const content = details
    ? `PR #${prNumber} CI ${status.toUpperCase()} - ${details}`
    : `PR #${prNumber} CI ${status.toUpperCase()}`;

  globalEventEmitter.emit("broadcast-ci-status", {
    content,
    prNumber,
    status,
    details,
  });
}

export function broadcastReviewComment(
  prNumber: number,
  author: string,
  commentCount: number,
): void {
  globalEventEmitter.emit("broadcast-review-comment", {
    content: `Review from ${author} on PR #${prNumber}: ${commentCount} comment(s)`,
    prNumber,
    author,
    commentCount,
  });
}

export function broadcastIssueUpdate(issue: Issue, action: string): void {
  const stateEmoji = issue.state === "open" ? "🔴" : "🟢";
  globalEventEmitter.emit("broadcast-issue-update", {
    content: `Issue #${issue.number} ${action} "${issue.title}" ${stateEmoji}`,
    issueNumber: issue.number,
    title: issue.title,
    action,
    state: issue.state,
  });
}

export function broadcastCommit(commit: Commit): void {
  const shortHash = commit.hash.slice(0, 7);
  const firstLine = commit.message.split('\n')[0];
  globalEventEmitter.emit("broadcast-commit", {
    content: `Commit ${shortHash} by ${commit.author}: ${firstLine}`,
    hash: commit.hash,
    author: commit.author,
    message: firstLine,
  });
}

export function emitLogMessage(level: "info" | "success" | "warning" | "error", message: string): void {
  globalEventEmitter.emit("log-message", {
    level,
    message,
  });
}
