import test from "node:test";
import assert from "node:assert/strict";

import { executeAction } from "../src/actions.js";
import type { OrchestratorAction } from "../src/types.js";

test("executeAction resolves review threads before requesting another review", async () => {
  const calls: string[] = [];
  const gitHubClient = {
    async createIssueComment(issueNumber: number, body: string): Promise<void> {
      calls.push(`comment:${issueNumber}:${body}`);
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
  };
  const sessions: Array<{ issueNumber: number; pullRequestNumber?: number; phase: string }> = [];
  const sessionStore = {
    async createSession(input: {
      issueNumber: number;
      pullRequestNumber?: number;
      phase: "implementation" | "review" | "address-review-comments" | "final-description";
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
    "comment:12:@copilot Please review this pull request using automatic model selection.",
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
    async updatePullRequestBody(): Promise<void> {
      calls.push("update");
    },
    async mergePullRequest(): Promise<void> {
      calls.push("merge");
    },
    async resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void> {
      calls.push(`resolve:${pullRequestNumber}`);
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
    "comment:10:@copilot Please review this pull request using automatic model selection.",
  ]);
});
