import { buildMergedPullRequestBody } from "./orchestrator.js";
import type {
  AgentSessionPhase,
  AgentSessionResult,
  AgentSessionStatus,
  Issue,
  OrchestratorAction,
  PullRequest,
  PullRequestInlineComment,
} from "./types.js";

export interface ActionGitHubClient {
  getDefaultBranch(): Promise<string>;
  createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ number: number; headSha: string }>;
  createPullRequestReview(input: {
    pullRequestNumber: number;
    commitId: string;
    body: string;
    inlineComments: ReadonlyArray<PullRequestInlineComment>;
  }): Promise<void>;
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;
  squashMergePullRequest(
    pullRequestNumber: number,
    subject: string,
    body: string,
  ): Promise<void>;
  resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void>;
  listUnresolvedReviewComments(pullRequestNumber: number): Promise<
    Array<{ path: string; line: number | null; body: string; author: string }>
  >;
  listFailingCheckRuns(input: {
    pullRequestNumber: number;
    headSha: string;
  }): Promise<Array<{ name: string; logExcerpt: string }>>;
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
  addressReviewComments(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    pullRequestTitle: string;
    pullRequestBody: string;
    headRefName: string;
    baseRefName: string;
    reviewComments: ReadonlyArray<{
      path: string;
      line: number | null;
      body: string;
      author: string;
    }>;
  }): Promise<{ headSha: string }>;
  resolveMergeConflicts(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    headRefName: string;
    baseRefName: string;
  }): Promise<{ headSha: string }>;
  addressFailingChecks(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    headRefName: string;
    baseRefName: string;
    failingChecks: ReadonlyArray<{ name: string; logExcerpt: string }>;
  }): Promise<{ headSha: string }>;
  reviewPullRequest(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    pullRequestTitle: string;
    pullRequestBody: string;
    headRefName: string;
    baseRefName: string;
  }): Promise<{
    summary: string;
    inlineComments: PullRequestInlineComment[];
  }>;
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
}

export interface ExecuteActionContext {
  owner: string;
  repo: string;
  /** All open issues in the snapshot — used to look up issue title/body when implementing. */
  issues: ReadonlyArray<Issue>;
  /** All open pull requests in the snapshot — used to look up branch / base. */
  pullRequests: ReadonlyArray<PullRequest>;
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
      const baseBranch = await gitHubClient.getDefaultBranch();
      const implementation = await claudeAgentClient.implementIssue({
        owner: context.owner,
        repo: context.repo,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body,
        baseBranch,
      });
      const created = await gitHubClient.createPullRequest({
        title: implementation.pullRequestTitle,
        body: implementation.pullRequestBody,
        head: implementation.branch,
        base: baseBranch,
      });
      await sessionStore.createSession({
        issueNumber: issue.number,
        pullRequestNumber: created.number,
        phase: "implementation",
        status: "completed",
        result: {
          pullRequestHeadSha: created.headSha,
          pullRequestBody: implementation.pullRequestBody,
        },
      });
      return {};
    }

    case "review-pull-request": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      const review = await claudeAgentClient.reviewPullRequest({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestBody: pullRequest.body,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
      });
      await gitHubClient.createPullRequestReview({
        pullRequestNumber: pullRequest.number,
        commitId: pullRequest.headSha,
        body: review.summary,
        inlineComments: review.inlineComments,
      });
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: pullRequest.number,
        phase: "review",
        status: "completed",
        result: {
          reviewCommentCount: review.inlineComments.length,
          pullRequestHeadSha: pullRequest.headSha,
        },
      });
      return {};
    }

    case "address-review-comments": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      const reviewComments = await gitHubClient.listUnresolvedReviewComments(
        pullRequest.number,
      );
      const update = await claudeAgentClient.addressReviewComments({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestBody: pullRequest.body,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
        reviewComments,
      });
      const addressReviewNoCommits = update.headSha === pullRequest.headSha;
      if (addressReviewNoCommits) {
        console.warn(
          `[vibrator] WARNING: address-review-comments on PR #${pullRequest.number} ` +
          `completed but the branch HEAD SHA did not change (${pullRequest.headSha}). ` +
          `Claude ran but pushed no new commits. ` +
          `Review comments that were sent to Claude:\n` +
          reviewComments
            .map((c, i) => `  ${i + 1}. ${c.path}${c.line !== null ? `:${c.line}` : ""} @${c.author}: ${c.body}`)
            .join("\n"),
        );
      }
      // Always resolve threads after addressing review comments. Claude either
      // made code changes or responded verbally — either way the threads have
      // been addressed. Leaving them open causes a new review on the next
      // iteration which posts fresh threads, leading to unbounded accumulation.
      await gitHubClient.resolvePullRequestReviewThreads(pullRequest.number);
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: pullRequest.number,
        phase: "address-review-comments",
        status: "completed",
        result: { pullRequestHeadSha: update.headSha, noCommitsPushed: addressReviewNoCommits },
      });
      return { noCommitsPushed: addressReviewNoCommits };
    }

    case "address-failing-checks": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      const failingChecks = await gitHubClient.listFailingCheckRuns({
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha,
      });
      const update = await claudeAgentClient.addressFailingChecks({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: pullRequest.number,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
        failingChecks,
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
      return { noCommitsPushed: checksNoCommits };
    }

    case "resolve-conflicts": {
      const pullRequest = findPullRequest(context, action.pullRequestNumber);
      const update = await claudeAgentClient.resolveMergeConflicts({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: pullRequest.number,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
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
      return { noCommitsPushed: conflictsNoCommits };
    }

    case "write-final-description": {
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

      const mergedBody = buildMergedPullRequestBody(
        description,
        action.closingIssueNumbers,
      );

      await gitHubClient.updatePullRequestBody(action.pullRequestNumber, mergedBody);

      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "final-description",
        status: "completed",
        result: {
          pullRequestBody: mergedBody,
          generatedDescription: description,
        },
      });
      return {};
    }

    case "squash-merge": {
      const mergedBody = buildMergedPullRequestBody(
        action.pullRequestBody,
        action.closingIssueNumbers,
      );

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
  }
}
