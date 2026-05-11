import test from "node:test";
import assert from "node:assert/strict";

import { executeAction } from "../src/actions.js";
import type { OrchestratorAction } from "../src/types.js";

test("executeAction assigns the issue to Copilot when starting implementation", async () => {
  const calls: string[] = [];
  const gitHubClient = {
    async createIssueComment(issueNumber: number, body: string): Promise<void> {
      calls.push(`comment:${issueNumber}:${body}`);
    },
    async assignIssueToCopilot(issueNumber: number): Promise<void> {
      calls.push(`assign:${issueNumber}`);
    },
    async updatePullRequestBody(): Promise<void> {
      calls.push("update");
    },
    async mergePullRequest(): Promise<void> {
      calls.push("merge");
    },
    async resolvePullRequestReviewThreads(): Promise<void> {
      calls.push("resolve");
    },
    async requestCopilotReview(pullRequestNumber: number): Promise<void> {
      calls.push(`request-review:${pullRequestNumber}`);
    },
  };
  const sessions: Array<{
    issueNumber: number;
    pullRequestNumber?: number;
    phase: string;
  }> = [];
  const sessionStore = {
    async createSession(input: {
      issueNumber: number;
      pullRequestNumber?: number;
      phase: "implementation" | "review" | "address-review-comments" | "final-description";
    }): Promise<void> {
      sessions.push(input);
    },
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    { type: "start-implementation", issueNumber: 7 },
    false,
  );

  assert.deepEqual(calls, ["assign:7"]);
  assert.deepEqual(sessions, [{ issueNumber: 7, phase: "implementation" }]);
});

test("executeAction resolves review threads before requesting another review", async () => {
  const calls: string[] = [];
  const gitHubClient = {
    async createIssueComment(issueNumber: number, body: string): Promise<void> {
      calls.push(`comment:${issueNumber}:${body}`);
    },
    async assignIssueToCopilot(issueNumber: number): Promise<void> {
      calls.push(`assign:${issueNumber}`);
    },
    async updatePullRequestBody(): Promise<void> {
      calls.push("update");
    },
    async mergePullRequest(): Promise<void> {
      calls.push("merge");
    },
    async resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void> {
      calls.push(`resolve:${pullRequestNumber}`);
    },
    async requestCopilotReview(pullRequestNumber: number): Promise<void> {
      calls.push(`request-review:${pullRequestNumber}`);
    },
  };
  const sessions: Array<{
    issueNumber: number;
    pullRequestNumber?: number;
    phase: string;
    result?: { pullRequestBody?: string; pullRequestHeadSha?: string };
  }> = [];
  const sessionStore = {
    async createSession(input: {
      issueNumber: number;
      pullRequestNumber?: number;
      phase: "implementation" | "review" | "address-review-comments" | "final-description";
      result?: { pullRequestBody?: string; pullRequestHeadSha?: string };
    }): Promise<void> {
      sessions.push(input);
    },
  };
  const action: OrchestratorAction = {
    type: "request-review",
    issueNumber: 9,
    pullRequestNumber: 12,
    resolveReviewThreads: true,
  };

  await executeAction(gitHubClient, sessionStore, action, false);

  assert.deepEqual(calls, [
    "resolve:12",
    "request-review:12",
  ]);
  assert.deepEqual(sessions, [
    { issueNumber: 9, pullRequestNumber: 12, phase: "review" },
  ]);
});

test("executeAction skips review-thread resolution for a first review request", async () => {
  const calls: string[] = [];
  const gitHubClient = {
    async createIssueComment(issueNumber: number, body: string): Promise<void> {
      calls.push(`comment:${issueNumber}:${body}`);
    },
    async assignIssueToCopilot(issueNumber: number): Promise<void> {
      calls.push(`assign:${issueNumber}`);
    },
    async updatePullRequestBody(): Promise<void> {
      calls.push("update");
    },
    async mergePullRequest(): Promise<void> {
      calls.push("merge");
    },
    async resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void> {
      calls.push(`resolve:${pullRequestNumber}`);
    },
    async requestCopilotReview(pullRequestNumber: number): Promise<void> {
      calls.push(`request-review:${pullRequestNumber}`);
    },
  };
  const sessionStore = {
    async createSession(): Promise<void> {},
  };
  const action: OrchestratorAction = {
    type: "request-review",
    issueNumber: 3,
    pullRequestNumber: 10,
  };

  await executeAction(gitHubClient, sessionStore, action, false);

  assert.deepEqual(calls, [
    "request-review:10",
  ]);
});

test("executeAction only requests explicit closing references in final descriptions", async () => {
  const calls: string[] = [];
  const gitHubClient = {
    async createIssueComment(issueNumber: number, body: string): Promise<void> {
      calls.push(`comment:${issueNumber}:${body}`);
    },
    async assignIssueToCopilot(issueNumber: number): Promise<void> {
      calls.push(`assign:${issueNumber}`);
    },
    async updatePullRequestBody(): Promise<void> {
      calls.push("update");
    },
    async mergePullRequest(): Promise<void> {
      calls.push("merge");
    },
    async resolvePullRequestReviewThreads(): Promise<void> {
      calls.push("resolve");
    },
    async requestCopilotReview(): Promise<void> {
      calls.push("request-review");
    },
  };
  const sessionStore = {
    async createSession(): Promise<void> {},
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    {
      type: "write-final-description",
      issueNumber: 3,
      pullRequestNumber: 10,
      closingIssueNumbers: [],
      pullRequestBody: "Current PR body",
    },
    false,
  );

  assert.deepEqual(calls, [
    "comment:10:@copilot Please write the final pull request description based on the final commits in this pull request.",
  ]);
});

test("executeAction formats multiple explicit closing references correctly", async () => {
  const calls: string[] = [];
  const gitHubClient = {
    async createIssueComment(issueNumber: number, body: string): Promise<void> {
      calls.push(`comment:${issueNumber}:${body}`);
    },
    async assignIssueToCopilot(issueNumber: number): Promise<void> {
      calls.push(`assign:${issueNumber}`);
    },
    async updatePullRequestBody(): Promise<void> {
      calls.push("update");
    },
    async mergePullRequest(): Promise<void> {
      calls.push("merge");
    },
    async resolvePullRequestReviewThreads(): Promise<void> {
      calls.push("resolve");
    },
    async requestCopilotReview(): Promise<void> {
      calls.push("request-review");
    },
  };
  const sessionStore = {
    async createSession(): Promise<void> {},
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    {
      type: "write-final-description",
      issueNumber: 3,
      pullRequestNumber: 10,
      closingIssueNumbers: [3, 8],
      pullRequestBody: "Current PR body",
    },
    false,
  );

  assert.deepEqual(calls, [
    'comment:10:@copilot Please write the final pull request description based on the final commits in this pull request and include "Closes #3", "Closes #8".',
  ]);
});

test("executeAction stores the current PR head sha when requesting review comment fixes", async () => {
  const sessions: Array<{
    issueNumber: number;
    pullRequestNumber?: number;
    phase: string;
    result?: { pullRequestHeadSha?: string };
  }> = [];
  const gitHubClient = {
    async createIssueComment(): Promise<void> {},
    async assignIssueToCopilot(): Promise<void> {},
    async updatePullRequestBody(): Promise<void> {},
    async mergePullRequest(): Promise<void> {},
    async resolvePullRequestReviewThreads(): Promise<void> {},
    async requestCopilotReview(): Promise<void> {},
  };
  const sessionStore = {
    async createSession(input: {
      issueNumber: number;
      pullRequestNumber?: number;
      phase: "implementation" | "review" | "address-review-comments" | "final-description";
      result?: { pullRequestHeadSha?: string };
    }): Promise<void> {
      sessions.push(input);
    },
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    {
      type: "address-review-comments",
      issueNumber: 4,
      pullRequestNumber: 11,
      pullRequestHeadSha: "sha-123",
      reviewCommentCount: 2,
    },
    false,
  );

  assert.deepEqual(sessions, [
    {
      issueNumber: 4,
      pullRequestNumber: 11,
      phase: "address-review-comments",
      result: { pullRequestHeadSha: "sha-123" },
    },
  ]);
});

test("executeAction stores the current PR body when requesting a final description", async () => {
  const sessions: Array<{
    issueNumber: number;
    pullRequestNumber?: number;
    phase: string;
    result?: { pullRequestBody?: string };
  }> = [];
  const gitHubClient = {
    async createIssueComment(): Promise<void> {},
    async assignIssueToCopilot(): Promise<void> {},
    async updatePullRequestBody(): Promise<void> {},
    async mergePullRequest(): Promise<void> {},
    async resolvePullRequestReviewThreads(): Promise<void> {},
    async requestCopilotReview(): Promise<void> {},
  };
  const sessionStore = {
    async createSession(input: {
      issueNumber: number;
      pullRequestNumber?: number;
      phase: "implementation" | "review" | "address-review-comments" | "final-description";
      result?: { pullRequestBody?: string };
    }): Promise<void> {
      sessions.push(input);
    },
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    {
      type: "write-final-description",
      issueNumber: 4,
      pullRequestNumber: 11,
      closingIssueNumbers: [4],
      pullRequestBody: "Current PR body",
    },
    false,
  );

  assert.deepEqual(sessions, [
    {
      issueNumber: 4,
      pullRequestNumber: 11,
      phase: "final-description",
      result: { pullRequestBody: "Current PR body" },
    },
  ]);
});
