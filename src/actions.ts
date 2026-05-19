import { buildMergedPullRequestBody, CHECKS_TIMEOUT_MS } from "./orchestrator.js";
import type {
  AgentSessionPhase,
  AgentSessionResult,
  AgentSessionStatus,
  Issue,
  OrchestratorAction,
  PullRequest,
} from "./types.js";

export interface ActionGitHubClient {
  getDefaultBranch(): Promise<string>;
  createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ number: number; headSha: string; created: boolean }>;
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;
  squashMergePullRequest(
    pullRequestNumber: number,
    subject: string,
    body: string,
  ): Promise<void>;
  listFailingCheckRuns(input: {
    pullRequestNumber: number;
    headSha: string;
  }): Promise<Array<{ name: string; logExcerpt: string }>>;
  cancelInProgressWorkflowRunsForHeadSha(headSha: string): Promise<number>;
  postComment(pullRequestNumber: number, body: string): Promise<void>;
  listPullRequestComments(pullRequestNumber: number): Promise<Array<{ author: string; body: string; createdAt: string }>>;
  /** Convert a PR from draft to ready-for-review (no-op if already ready). */
  markPullRequestReadyForReview?(pullRequestNumber: number): Promise<void>;
  /** Request review from specific GitHub users. */
  requestPullRequestReview?(pullRequestNumber: number, reviewers: string[]): Promise<void>;
  /** Move an issue to a project status (e.g. "In Progress"). */
  moveIssueToProjectStatus?(projectNumber: number, issueNumber: number, status: string): Promise<void>;
}

export interface ActionClaudeAgentClient {
  implementIssue(params: {
    owner: string;
    repo: string;
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    baseBranch: string;
  }): Promise<{
    branch: string;
    pullRequestTitle: string;
    pullRequestBody: string;
    headSha: string;
  }>;
  selfReview(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    pullRequestTitle: string;
    pullRequestBody: string;
    headRefName: string;
    baseRefName: string;
    issueNumber?: number;
    issueTitle?: string;
    issueBody?: string;
    userComments?: ReadonlyArray<{ author: string; body: string; createdAt: string }>;
  }): Promise<{ madeChanges: boolean; headSha: string }>;
  resolveMergeConflicts(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    headRefName: string;
    baseRefName: string;
    userComments?: ReadonlyArray<{ author: string; body: string; createdAt: string }>;
  }): Promise<{ headSha: string }>;
  addressFailingChecks(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    headRefName: string;
    baseRefName: string;
    failingChecks: ReadonlyArray<{ name: string; logExcerpt: string }>;
    userComments?: ReadonlyArray<{ author: string; body: string; createdAt: string }>;
  }): Promise<{ headSha: string }>;
  generateFinalDescription(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    pullRequestTitle: string;
    pullRequestBody: string;
    headRefName: string;
    baseRefName: string;
    closingIssueNumbers: readonly number[];
  }): Promise<string>;
}

export interface ActionSessionStore {
  createSession(input: {
    issueNumber?: number | undefined;
    pullRequestNumber?: number;
    phase: AgentSessionPhase;
    status?: AgentSessionStatus;
    result?: AgentSessionResult;
  }): Promise<unknown>;
  /** Record the ISO timestamp of the most recent PR comment vibrator has read. */
  setLastReadCommentAt?(pullRequestNumber: number, createdAt: string): Promise<void>;
}

export interface ExecuteActionContext {
  owner: string;
  repo: string;
  /** All open issues in the snapshot — used to look up issue title/body when implementing. */
  issues: ReadonlyArray<Issue>;
  /** All open pull requests in the snapshot — used to look up branch / base. */
  pullRequests: ReadonlyArray<PullRequest>;
  /** When set, enables Human-in-the-Loop project mode behaviours. */
  projectMode?: {
    projectNumber: number;
    reviewers: string[];
  };
}

function findIssue(context: ExecuteActionContext, issueNumber: number): Issue {
  const issue = context.issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    throw new Error(`Issue #${issueNumber} not found in the current snapshot.`);
  }
  return issue;
}

function findPullRequest(
  context: ExecuteActionContext,
  pullRequestNumber: number,
): PullRequest {
  const pullRequest = context.pullRequests.find(
    (candidate) => candidate.number === pullRequestNumber,
  );
  if (!pullRequest) {
    throw new Error(`Pull request #${pullRequestNumber} not found in the current snapshot.`);
  }
  return pullRequest;
}

export interface ExecuteActionResult {
  /**
   * True when a branch-modifying action (address-review-comments,
   * address-failing-checks, resolve-conflicts) completed but the branch HEAD
   * SHA did not change — i.e. Claude ran but pushed no new commits.
   */
  noCommitsPushed?: boolean;
}

export async function executeAction(
  gitHubClient: ActionGitHubClient,
  sessionStore: ActionSessionStore,
  claudeAgentClient: ActionClaudeAgentClient,
  action: OrchestratorAction,
  dryRun: boolean,
  context: ExecuteActionContext,
): Promise<ExecuteActionResult> {
  if (dryRun) {
    return {};
  }

  switch (action.type) {
    case "start-implementation": {
      const issue = findIssue(context, action.issueNumber);

      // In project mode, mark the issue as "In Progress" before starting work.
      if (context.projectMode && gitHubClient.moveIssueToProjectStatus) {
        await gitHubClient.moveIssueToProjectStatus(
          context.projectMode.projectNumber,
          issue.number,
          "In Progress",
        );
      }

      const baseBranch = await gitHubClient.getDefaultBranch();
      const implementation = await claudeAgentClient.implementIssue({
        owner: context.owner,
        repo: context.repo,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body,
        baseBranch,
      });
      const pullRequestBody = buildMergedPullRequestBody(implementation.pullRequestBody, [
        issue.number,
      ]);
      const created = await gitHubClient.createPullRequest({
        title: implementation.pullRequestTitle,
        body: pullRequestBody,
        head: implementation.branch,
        base: baseBranch,
      });
      if (!created.created) {
        const existingPullRequest = context.pullRequests.find(
          (pullRequest) => pullRequest.headRefName === implementation.branch,
        );
        if (existingPullRequest !== undefined && existingPullRequest.body.trim() !== pullRequestBody.trim()) {
          await gitHubClient.updatePullRequestBody(created.number, pullRequestBody);
        }
      }
      // Only create a session if this is a new PR.
      if (created.created) {
        await sessionStore.createSession({
          issueNumber: issue.number,
          pullRequestNumber: created.number,
          phase: "implementation",
          status: "completed",
          result: {
            pullRequestHeadSha: created.headSha,
            pullRequestBody,
          },
        });
      }
      return {};
    }

    case "self-review": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      const issue =
        action.issueNumber !== undefined
          ? context.issues.find((i) => i.number === action.issueNumber)
          : undefined;
      const userComments = await gitHubClient.listPullRequestComments(pullRequest.number);

      // Record the last-read comment timestamp so re-queue detection works.
      const latestCommentAt = userComments.reduce<string | undefined>(
        (latest, c) => (!latest || c.createdAt > latest ? c.createdAt : latest),
        undefined,
      );
      if (latestCommentAt && sessionStore.setLastReadCommentAt) {
        await sessionStore.setLastReadCommentAt(pullRequest.number, latestCommentAt);
      }

      const result = await claudeAgentClient.selfReview({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestBody: pullRequest.body,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
        ...(issue !== undefined && {
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueBody: issue.body,
        }),
        userComments,
      });
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: pullRequest.number,
        phase: "self-review",
        status: "completed",
        result: {
          madeChanges: result.madeChanges,
          pullRequestHeadSha: result.headSha,
        },
      });
      const reviewComment = result.madeChanges
        ? "Reviewed code and pushed fixes."
        : "Reviewed code, no issues found.";
      await gitHubClient.postComment(pullRequest.number, reviewComment);
      return {};
    }

    case "address-failing-checks": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      // Cancel any runs that are still in progress so Claude doesn't try to
      // diagnose a job that hasn't finished yet.
      const cancelledCount = await gitHubClient.cancelInProgressWorkflowRunsForHeadSha(
        pullRequest.headSha,
      );
      if (cancelledCount > 0) {
        const pushedAt = pullRequest.headCommitPushedAt;
        const pendingMs = pushedAt !== undefined ? Date.now() - Date.parse(pushedAt) : undefined;
        const pendingDesc =
          pendingMs !== undefined
            ? (() => {
                const totalSecs = Math.floor(pendingMs / 1000);
                const m = Math.floor(totalSecs / 60);
                const s = totalSecs % 60;
                return m > 0 ? `${m}m ${s}s` : `${s}s`;
              })()
            : "unknown duration";
        const thresholdMin = Math.round(CHECKS_TIMEOUT_MS / 60_000);
        console.log(
          `[vibrator] Cancelled ${cancelledCount} in-progress workflow run(s) for PR #${pullRequest.number} ` +
          `because CI checks have been pending for ${pendingDesc}, exceeding the ${thresholdMin}-minute timeout threshold.`,
        );
      }
      const [failingChecks, userComments] = await Promise.all([
        gitHubClient.listFailingCheckRuns({
          pullRequestNumber: pullRequest.number,
          headSha: pullRequest.headSha,
        }),
        gitHubClient.listPullRequestComments(pullRequest.number),
      ]);
      const update = await claudeAgentClient.addressFailingChecks({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: pullRequest.number,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
        failingChecks,
        userComments,
      });
      const checksNoCommits = update.headSha === pullRequest.headSha;
      if (checksNoCommits) {
        console.warn(
          `[vibrator] WARNING: address-failing-checks on PR #${pullRequest.number} ` +
          `completed but the branch HEAD SHA did not change (${pullRequest.headSha}). ` +
          `Claude ran but pushed no new commits. ` +
          `Failing checks that were sent to Claude: ${failingChecks.map((c) => c.name).join(", ") || "(none)"}`,
        );
      }
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: pullRequest.number,
        phase: "address-failing-checks",
        status: "completed",
        result: { pullRequestHeadSha: update.headSha },
      });
      const checksComment = checksNoCommits
        ? "Investigated failing CI checks; no code changes were needed."
        : `Addressed failing CI checks and pushed a fix (${failingChecks.map((c) => c.name).join(", ") || "unknown checks"}).`;
      await gitHubClient.postComment(pullRequest.number, checksComment);
      return { noCommitsPushed: checksNoCommits };
    }

    case "resolve-conflicts": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      const userComments = await gitHubClient.listPullRequestComments(pullRequest.number);
      const update = await claudeAgentClient.resolveMergeConflicts({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: pullRequest.number,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
        userComments,
      });
      const conflictsNoCommits = update.headSha === pullRequest.headSha;
      if (conflictsNoCommits) {
        console.warn(
          `[vibrator] WARNING: resolve-conflicts on PR #${pullRequest.number} ` +
          `completed but the branch HEAD SHA did not change (${pullRequest.headSha}). ` +
          `Claude ran but pushed no new commits.`,
        );
      }
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: pullRequest.number,
        phase: "resolve-conflicts",
        status: "completed",
        result: { pullRequestHeadSha: update.headSha },
      });
      const conflictsComment = conflictsNoCommits
        ? "Investigated merge conflicts; no changes were needed."
        : "Resolved merge conflicts and pushed updated branch.";
      await gitHubClient.postComment(pullRequest.number, conflictsComment);
      return { noCommitsPushed: conflictsNoCommits };
    }

    case "squash-merge": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      const description = await claudeAgentClient.generateFinalDescription({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: action.pullRequestNumber,
        pullRequestTitle: action.pullRequestTitle,
        pullRequestBody: action.pullRequestBody,
        headRefName: action.pullRequestHeadRefName,
        baseRefName: pullRequest.baseRefName,
        closingIssueNumbers: action.closingIssueNumbers,
      });

      const mergedBody = buildMergedPullRequestBody(description, action.closingIssueNumbers);

      await gitHubClient.updatePullRequestBody(action.pullRequestNumber, mergedBody);
      await gitHubClient.squashMergePullRequest(
        action.pullRequestNumber,
        action.pullRequestTitle,
        mergedBody,
      );

      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "squash-merge",
        status: "completed",
        result: { pullRequestBody: mergedBody },
      });
      return {};
    }

    case "request-review": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);

      // Capture the latest human comment timestamp before requesting review,
      // so we can detect new comments that arrive after this point.
      const userComments = await gitHubClient.listPullRequestComments(pullRequest.number);
      const latestCommentAt = userComments.reduce<string | undefined>(
        (latest, c) => (!latest || c.createdAt > latest ? c.createdAt : latest),
        undefined,
      );
      // Use the current time as the last-read marker so any subsequent
      // comments are correctly identified as "new".
      const lastReadMarker = latestCommentAt ?? new Date().toISOString();
      if (sessionStore.setLastReadCommentAt) {
        await sessionStore.setLastReadCommentAt(pullRequest.number, lastReadMarker);
      }

      // Convert from draft to ready-for-review if needed.
      if (pullRequest.draft && gitHubClient.markPullRequestReadyForReview) {
        await gitHubClient.markPullRequestReadyForReview(pullRequest.number);
      }

      // Request review from the configured human reviewer(s).
      if (action.reviewers.length > 0 && gitHubClient.requestPullRequestReview) {
        await gitHubClient.requestPullRequestReview(pullRequest.number, action.reviewers);
      }

      // Move the issue to "In Review" in the project board.
      if (
        action.issueNumber !== undefined &&
        context.projectMode &&
        gitHubClient.moveIssueToProjectStatus
      ) {
        await gitHubClient.moveIssueToProjectStatus(
          context.projectMode.projectNumber,
          action.issueNumber,
          "In Review",
        );
      }

      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: pullRequest.number,
        phase: "request-review",
        status: "completed",
      });

      const reviewersText =
        action.reviewers.length > 0
          ? ` from ${action.reviewers.map((r) => `@${r}`).join(", ")}`
          : "";
      await gitHubClient.postComment(
        pullRequest.number,
        `Automated self-review passed. Requesting human review${reviewersText}.`,
      );
      return {};
    }
  }
}
