import { buildMergedPullRequestBody } from "./orchestrator.js";
import type { AgentSessionPhase, OrchestratorAction } from "./types.js";

export interface ActionGitHubClient {
  createIssueComment(issueNumber: number, body: string): Promise<void>;
  assignIssueToCopilot(issueNumber: number): Promise<void>;
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;
  mergePullRequest(pullRequestNumber: number): Promise<void>;
  squashMergePullRequest(
    pullRequestNumber: number,
    subject: string,
    body: string,
  ): Promise<void>;
  resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void>;
  requestCopilotReview(pullRequestNumber: number): Promise<void>;
}

export interface ActionLocalCopilotChatClient {
  generateFinalDescription(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    pullRequestTitle: string;
    pullRequestBody: string;
    headRefName: string;
    closingIssueNumbers: readonly number[];
  }): Promise<string>;
}

export interface ActionSessionStore {
  createSession(input: {
    issueNumber?: number | undefined;
    pullRequestNumber?: number;
    phase: AgentSessionPhase;
    status?: "queued" | "in_progress" | "completed" | "failed";
    result?: {
      pullRequestBody?: string;
      pullRequestHeadSha?: string;
      generatedDescription?: string;
    };
  }): Promise<unknown>;
}

export interface ExecuteActionContext {
  owner: string;
  repo: string;
}

export async function executeAction(
  gitHubClient: ActionGitHubClient,
  sessionStore: ActionSessionStore,
  action: OrchestratorAction,
  dryRun: boolean,
  localCopilotChatClient: ActionLocalCopilotChatClient,
  context: ExecuteActionContext,
): Promise<void> {
  if (dryRun) {
    return;
  }

  switch (action.type) {
    case "start-implementation":
      await gitHubClient.assignIssueToCopilot(action.issueNumber);
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        phase: "implementation",
      });
      return;
    case "request-review":
      if (action.resolveReviewThreads) {
        await gitHubClient.resolvePullRequestReviewThreads(action.pullRequestNumber);
      }
      await gitHubClient.requestCopilotReview(action.pullRequestNumber);
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "review",
      });
      return;
    case "address-review-comments":
      await gitHubClient.createIssueComment(
        action.pullRequestNumber,
        `@copilot Please address every review comment in this pull request and push the changes. (${action.reviewCommentCount} review comments were found.)`,
      );
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "address-review-comments",
        result: { pullRequestHeadSha: action.pullRequestHeadSha },
      });
      return;
    case "write-final-description": {
      // New flow: run a local Copilot chat session inside a checkout of the
      // PR branch to generate the final description, update the PR body via
      // the GitHub REST API, then squash-merge the PR using the description
      // as the commit message body. This replaces the previous flow that
      // posted an `@copilot` comment on the PR and waited for Copilot to
      // edit the description out-of-band.
      const description = await localCopilotChatClient.generateFinalDescription({
        owner: context.owner,
        repo: context.repo,
        pullRequestNumber: action.pullRequestNumber,
        pullRequestTitle: action.pullRequestTitle,
        pullRequestBody: action.pullRequestBody,
        headRefName: action.pullRequestHeadRefName,
        closingIssueNumbers: action.closingIssueNumbers,
      });

      const mergedBody = buildMergedPullRequestBody(
        description,
        action.closingIssueNumbers,
      );

      await gitHubClient.updatePullRequestBody(action.pullRequestNumber, mergedBody);
      await gitHubClient.squashMergePullRequest(
        action.pullRequestNumber,
        action.pullRequestTitle,
        mergedBody,
      );

      // Record the work as a completed final-description session so it shows
      // up in history and so the orchestrator's planning machinery sees the
      // phase as already finished (the PR will also disappear from
      // listOpenPullRequests on the next iteration).
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
      return;
    }
    case "merge-pull-request":
      await gitHubClient.updatePullRequestBody(
        action.pullRequestNumber,
        buildMergedPullRequestBody(action.pullRequestBody, action.closingIssueNumbers),
      );
      await gitHubClient.mergePullRequest(action.pullRequestNumber);
      return;
    case "resolve-conflicts":
      await gitHubClient.createIssueComment(
        action.pullRequestNumber,
        "@copilot This pull request has merge conflicts. Please resolve the conflicts and push the changes.",
      );
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "resolve-conflicts",
        result: { pullRequestHeadSha: action.pullRequestHeadSha },
      });
      return;
  }
}
