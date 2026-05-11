import test from "node:test";
import assert from "node:assert/strict";

import { executeAction } from "../src/actions.js";
import type {
  ActionGitHubClient,
  ActionLocalCopilotChatClient,
  ActionSessionStore,
  ExecuteActionContext,
} from "../src/actions.js";
import type { AgentSessionPhase, OrchestratorAction } from "../src/types.js";

type SessionInput = {
  issueNumber: number | undefined;
  pullRequestNumber?: number;
  phase: AgentSessionPhase;
  status?: "queued" | "in_progress" | "completed" | "failed";
  result?: {
    pullRequestBody?: string;
    pullRequestHeadSha?: string;
    generatedDescription?: string;
  };
};

interface Harness {
  calls: string[];
  sessions: SessionInput[];
  gitHubClient: ActionGitHubClient;
  sessionStore: ActionSessionStore;
  localCopilotChatClient: ActionLocalCopilotChatClient;
  context: ExecuteActionContext;
}

function createHarness(overrides: { generatedDescription?: string } = {}): Harness {
  const calls: string[] = [];
  const sessions: SessionInput[] = [];
  const gitHubClient: ActionGitHubClient = {
    async createIssueComment(issueNumber: number, body: string): Promise<void> {
      calls.push(`comment:${issueNumber}:${body}`);
    },
    async assignIssueToCopilot(issueNumber: number): Promise<void> {
      calls.push(`assign:${issueNumber}`);
    },
    async updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void> {
      calls.push(`update-body:${pullRequestNumber}:${body}`);
    },
    async mergePullRequest(pullRequestNumber: number): Promise<void> {
      calls.push(`merge:${pullRequestNumber}`);
    },
    async squashMergePullRequest(
      pullRequestNumber: number,
      subject: string,
      body: string,
    ): Promise<void> {
      calls.push(`squash-merge:${pullRequestNumber}:${subject}:${body}`);
    },
    async resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void> {
      calls.push(`resolve:${pullRequestNumber}`);
    },
    async requestCopilotReview(pullRequestNumber: number): Promise<void> {
      calls.push(`request-review:${pullRequestNumber}`);
    },
  };
  const sessionStore: ActionSessionStore = {
    async createSession(input: SessionInput): Promise<unknown> {
      sessions.push(input);
      return input;
    },
  };
  const generatedDescription = overrides.generatedDescription ?? "Generated description";
  const localCopilotChatClient: ActionLocalCopilotChatClient = {
    async generateFinalDescription(params): Promise<string> {
      calls.push(`generate:${params.pullRequestNumber}`);
      return generatedDescription;
    },
  };
  return {
    calls,
    sessions,
    gitHubClient,
    sessionStore,
    localCopilotChatClient,
    context: { owner: "acme", repo: "widgets" },
  };
}

async function run(harness: Harness, action: OrchestratorAction, dryRun = false): Promise<void> {
  await executeAction(
    harness.gitHubClient,
    harness.sessionStore,
    action,
    dryRun,
    harness.localCopilotChatClient,
    harness.context,
  );
}

test("executeAction assigns the issue to Copilot when starting implementation", async () => {
  const harness = createHarness();

  await run(harness, { type: "start-implementation", issueNumber: 7 });

  assert.deepEqual(harness.calls, ["assign:7"]);
  assert.deepEqual(harness.sessions, [
    { issueNumber: 7, phase: "implementation" },
  ]);
});

test("executeAction resolves review threads before requesting another review", async () => {
  const harness = createHarness();

  await run(harness, {
    type: "request-review",
    issueNumber: 9,
    pullRequestNumber: 12,
    resolveReviewThreads: true,
  });

  assert.deepEqual(harness.calls, ["resolve:12", "request-review:12"]);
  assert.deepEqual(harness.sessions, [
    { issueNumber: 9, pullRequestNumber: 12, phase: "review" },
  ]);
});

test("executeAction skips review-thread resolution for a first review request", async () => {
  const harness = createHarness();

  await run(harness, {
    type: "request-review",
    issueNumber: 3,
    pullRequestNumber: 10,
  });

  assert.deepEqual(harness.calls, ["request-review:10"]);
});

test("executeAction generates a description via the local copilot CLI and squash-merges the PR", async () => {
  const harness = createHarness({ generatedDescription: "Polished description" });

  await run(harness, {
    type: "write-final-description",
    issueNumber: 3,
    pullRequestNumber: 10,
    pullRequestTitle: "Add widget",
    pullRequestHeadRefName: "feature/add-widget",
    closingIssueNumbers: [],
    pullRequestBody: "Current PR body",
  });

  assert.deepEqual(harness.calls, [
    "generate:10",
    "update-body:10:Polished description",
    "squash-merge:10:Add widget:Polished description",
  ]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 3,
      pullRequestNumber: 10,
      phase: "final-description",
      status: "completed",
      result: {
        pullRequestBody: "Polished description",
        generatedDescription: "Polished description",
      },
    },
  ]);
});

test("executeAction appends missing closing references to the generated description before merging", async () => {
  const harness = createHarness({
    generatedDescription: "Summary of changes.\n\nMore details.",
  });

  await run(harness, {
    type: "write-final-description",
    issueNumber: 3,
    pullRequestNumber: 10,
    pullRequestTitle: "Fix bug",
    pullRequestHeadRefName: "fix/bug",
    closingIssueNumbers: [3, 8],
    pullRequestBody: "Current PR body",
  });

  const expectedBody = "Summary of changes.\n\nMore details.\n\nCloses #3\n\nCloses #8";
  assert.deepEqual(harness.calls, [
    "generate:10",
    `update-body:10:${expectedBody}`,
    `squash-merge:10:Fix bug:${expectedBody}`,
  ]);
});

test("executeAction stores the current PR head sha when requesting review comment fixes", async () => {
  const harness = createHarness();

  await run(harness, {
    type: "address-review-comments",
    issueNumber: 4,
    pullRequestNumber: 11,
    pullRequestHeadSha: "sha-123",
    reviewCommentCount: 2,
  });

  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 4,
      pullRequestNumber: 11,
      phase: "address-review-comments",
      result: { pullRequestHeadSha: "sha-123" },
    },
  ]);
});

test("executeAction is a no-op when dry-run is enabled", async () => {
  const harness = createHarness();

  await run(
    harness,
    {
      type: "write-final-description",
      issueNumber: 3,
      pullRequestNumber: 10,
      pullRequestTitle: "T",
      pullRequestHeadRefName: "b",
      closingIssueNumbers: [],
      pullRequestBody: "body",
    },
    true,
  );

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.sessions, []);
});
