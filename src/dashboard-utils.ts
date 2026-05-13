import { globalEventEmitter } from "./event-emitter.js";
import type { RepositorySnapshot, PullRequest, Issue, Commit } from "./types.js";

export function broadcastRepositorySnapshot(
  snapshot: RepositorySnapshot,
  owner: string,
  repo: string,
): void {
  const openPRs = snapshot.pullRequests.filter((pr) => pr.state === "open");
  const draftPRs = openPRs.filter((pr) => pr.draft);
  const readyPRs = openPRs.filter((pr) => !pr.draft);

  const checkStats = {
    success: readyPRs.filter((pr) => pr.checksStatus === "success").length,
    failure: readyPRs.filter((pr) => pr.checksStatus === "failure").length,
    pending: readyPRs.filter((pr) => pr.checksStatus === "pending").length,
  };

  globalEventEmitter.emit("broadcast-github-activity", {
    content: `Repository snapshot: ${snapshot.issues.length} open issues, ${openPRs.length} PRs (${draftPRs.length} draft, ${readyPRs.length} ready), ${snapshot.agentSessions.length} active sessions, checks: ${checkStats.success} success, ${checkStats.failure} failed, ${checkStats.pending} pending`,
    repo: `${owner}/${repo}`,
    issueCount: snapshot.issues.length,
    prCount: openPRs.length,
    draftCount: draftPRs.length,
    readyCount: readyPRs.length,
    sessionCount: snapshot.agentSessions.length,
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
