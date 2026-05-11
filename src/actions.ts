import { buildMergedPullRequestBody } from "./orchestrator.js";
import type { AgentSessionPhase, OrchestratorAction } from "./types.js";

export interface ActionGitHubClient {
  createIssueComment(issueNumber: number, body: string): Promise<void>;
  assignIssueToCopilot(issueNumber: number): Promise<void>;
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;
  mergePullRequest(pullRequestNumber: number): Promise<void>;
  resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void>;
}

export interface ActionSessionStore {
  createSession(input: {
    issueNumber: number;
    pullRequestNumber?: number;
    phase: AgentSessionPhase;
    result?: {
      pullRequestBody?: string;
      pullRequestHeadSha?: string;
    };
  }): Promise<unknown>;
}

function buildFinalDescriptionPrompt(closingIssueNumbers: readonly number[]): string {
  if (closingIssueNumbers.length === 0) {
    return "@copilot Please write the final pull request description based on the final commits in this pull request.";
  }

  const closingReferences = closingIssueNumbers
    .map((issueNumber) => `"Closes #${issueNumber}"`)
    .join(", ");
  return `@copilot Please write the final pull request description based on the final commits in this pull request and include ${closingReferences}.`;
}

export async function executeAction(
  gitHubClient: ActionGitHubClient,
  sessionStore: ActionSessionStore,
  action: OrchestratorAction,
  dryRun: boolean,
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
      await gitHubClient.createIssueComment(
        action.pullRequestNumber,
        "@copilot Please review this pull request using automatic model selection.",
      );
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
    case "write-final-description":
      await gitHubClient.createIssueComment(
        action.pullRequestNumber,
        buildFinalDescriptionPrompt(action.closingIssueNumbers),
      );
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "final-description",
        result: { pullRequestBody: action.pullRequestBody },
      });
      return;
    case "merge-pull-request":
      await gitHubClient.updatePullRequestBody(
        action.pullRequestNumber,
        buildMergedPullRequestBody(action.pullRequestBody, action.closingIssueNumbers),
      );
      await gitHubClient.mergePullRequest(action.pullRequestNumber);
      return;
  }
}
