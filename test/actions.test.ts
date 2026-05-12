import test from "node:test";
import assert from "node:assert/strict";

import { executeAction } from "../src/actions.js";
import type {
  ActionClaudeAgentClient,
  ActionGitHubClient,
  ActionSessionStore,
  ExecuteActionContext,
} from "../src/actions.js";
import type {
  AgentSessionPhase,
  AgentSessionResult,
  AgentSessionStatus,
  Issue,
  OrchestratorAction,
  PullRequest,
  PullRequestInlineComment,
} from "../src/types.js";

type SessionInput = {
  issueNumber?: number | undefined;
  pullRequestNumber?: number;
  phase: AgentSessionPhase;
  status?: AgentSessionStatus;
  result?: AgentSessionResult;
};

interface Harness {
  calls: string[];
  sessions: SessionInput[];
  gitHubClient: ActionGitHubClient;
  sessionStore: ActionSessionStore;
  claudeAgentClient: ActionClaudeAgentClient;
  context: ExecuteActionContext;
}

function createIssue(overrides: Partial<Issue> & Pick<Issue, "number">): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    body: overrides.body ?? "",
    state: overrides.state ?? "open",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    type: overrides.type ?? null,
  };
}

function createPullRequest(
  overrides: Partial<PullRequest> & Pick<PullRequest, "number" | "linkedIssueNumbers">,
): PullRequest {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    body: overrides.body ?? "",
    headSha: overrides.headSha ?? `sha-${overrides.number}`,
    headRefName: overrides.headRefName ?? `branch-${overrides.number}`,
    baseRefName: overrides.baseRefName ?? "main",
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    hasMergeConflicts: overrides.hasMergeConflicts ?? false,
    hasCleanReviewOnHead: overrides.hasCleanReviewOnHead ?? false,
    unresolvedReviewCommentCount: overrides.unresolvedReviewCommentCount ?? 0,
    checksStatus: overrides.checksStatus ?? "success",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    linkedIssueNumbers: overrides.linkedIssueNumbers,
    closingIssueNumbers: overrides.closingIssueNumbers ?? overrides.linkedIssueNumbers,
  };
}

function createHarness(input: {
  issues?: Issue[];
  pullRequests?: PullRequest[];
  reviewSummary?: string;
  reviewInlineComments?: PullRequestInlineComment[];
  generatedDescription?: string;
  implementation?: {
    branch: string;
    pullRequestTitle: string;
    pullRequestBody: string;
    headSha: string;
  };
  unresolvedReviewComments?: Array<{
    path: string;
    line: number | null;
    body: string;
    author: string;
  }>;
  failingCheckRuns?: Array<{ name: string; logExcerpt: string }>;
  newPullRequest?: { number: number; headSha: string };
}): Harness {
  const calls: string[] = [];
  const sessions: SessionInput[] = [];
  const newPullRequest = input.newPullRequest ?? { number: 999, headSha: "sha-new" };

  const gitHubClient: ActionGitHubClient = {
    async getDefaultBranch(): Promise<string> {
      calls.push("get-default-branch");
      return "main";
    },
    async createPullRequest(args): Promise<{ number: number; headSha: string }> {
      calls.push(
        `create-pr:${args.head}->${args.base}:${args.title}:${args.body.replace(/\n/g, "\\n")}`,
      );
      return newPullRequest;
    },
    async createPullRequestReview(args): Promise<void> {
      calls.push(
        `create-review:${args.pullRequestNumber}:${args.commitId}:` +
          `${args.inlineComments.length}-comments:${args.body}`,
      );
    },
    async updatePullRequestBody(pullRequestNumber, body): Promise<void> {
      calls.push(`update-body:${pullRequestNumber}:${body}`);
    },
    async squashMergePullRequest(pullRequestNumber, subject, body): Promise<void> {
      calls.push(`squash-merge:${pullRequestNumber}:${subject}:${body}`);
    },
    async resolvePullRequestReviewThreads(pullRequestNumber): Promise<void> {
      calls.push(`resolve-threads:${pullRequestNumber}`);
    },
    async listUnresolvedReviewComments(pullRequestNumber) {
      calls.push(`list-unresolved:${pullRequestNumber}`);
      return input.unresolvedReviewComments ?? [];
    },
    async listFailingCheckRuns(args) {
      calls.push(`list-failing:${args.pullRequestNumber}:${args.headSha}`);
      return input.failingCheckRuns ?? [];
    },
  };

  const sessionStore: ActionSessionStore = {
    async createSession(session: SessionInput): Promise<unknown> {
      sessions.push(session);
      return session;
    },
  };

  const claudeAgentClient: ActionClaudeAgentClient = {
    async implementIssue(params) {
      calls.push(`implement:${params.issueNumber}:${params.baseBranch}`);
      return (
        input.implementation ?? {
          branch: `vibrator/issue-${params.issueNumber}`,
          pullRequestTitle: `Resolve issue #${params.issueNumber}`,
          pullRequestBody: `Closes #${params.issueNumber}`,
          headSha: "sha-impl",
        }
      );
    },
    async addressReviewComments(params) {
      calls.push(
        `address-review:${params.pullRequestNumber}:${params.reviewComments.length}-comments`,
      );
      return { headSha: "sha-after-address" };
    },
    async resolveMergeConflicts(params) {
      calls.push(`resolve-conflicts:${params.pullRequestNumber}`);
      return { headSha: "sha-after-resolve" };
    },
    async addressFailingChecks(params) {
      calls.push(
        `address-checks:${params.pullRequestNumber}:${params.failingChecks.length}-checks`,
      );
      return { headSha: "sha-after-checks" };
    },
    async reviewPullRequest(params) {
      calls.push(`review:${params.pullRequestNumber}`);
      return {
        summary: input.reviewSummary ?? "LGTM",
        inlineComments: input.reviewInlineComments ?? [],
      };
    },
    async generateFinalDescription(params) {
      calls.push(`generate-desc:${params.pullRequestNumber}`);
      return input.generatedDescription ?? "Final description.";
    },
  };

  return {
    calls,
    sessions,
    gitHubClient,
    sessionStore,
    claudeAgentClient,
    context: {
      owner: "acme",
      repo: "widgets",
      issues: input.issues ?? [],
      pullRequests: input.pullRequests ?? [],
    },
  };
}

async function run(
  harness: Harness,
  action: OrchestratorAction,
  dryRun = false,
): Promise<void> {
  await executeAction(
    harness.gitHubClient,
    harness.sessionStore,
    harness.claudeAgentClient,
    action,
    dryRun,
    harness.context,
  );
}

test("executeAction implements an issue, opens a PR, and records the session", async () => {
  const harness = createHarness({
    issues: [createIssue({ number: 7, title: "Add widget", body: "Make it." })],
    implementation: {
      branch: "vibrator/issue-7-add-widget",
      pullRequestTitle: "Add widget",
      pullRequestBody: "Added widget.\n\nCloses #7",
      headSha: "sha-impl-7",
    },
    newPullRequest: { number: 100, headSha: "sha-impl-7" },
  });

  await run(harness, { type: "start-implementation", issueNumber: 7 });

  assert.deepEqual(harness.calls, [
    "get-default-branch",
    "implement:7:main",
    "create-pr:vibrator/issue-7-add-widget->main:Add widget:Added widget.\\n\\nCloses #7",
  ]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 7,
      pullRequestNumber: 100,
      phase: "implementation",
      status: "completed",
      result: {
        pullRequestHeadSha: "sha-impl-7",
        pullRequestBody: "Added widget.\n\nCloses #7",
      },
    },
  ]);
});

test("executeAction posts an approval review when Claude returns no inline comments", async () => {
  const pullRequest = createPullRequest({
    number: 10,
    linkedIssueNumbers: [5],
    headSha: "sha-head-10",
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    reviewSummary: "Looks great.",
    reviewInlineComments: [],
  });

  await run(harness, {
    type: "review-pull-request",
    issueNumber: 5,
    pullRequestNumber: 10,
    pullRequestHeadSha: "sha-head-10",
  });

  assert.deepEqual(harness.calls, [
    "review:10",
    "create-review:10:sha-head-10:0-comments:Looks great.",
  ]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 5,
      pullRequestNumber: 10,
      phase: "review",
      status: "completed",
      result: {
        reviewCommentCount: 0,
        pullRequestHeadSha: "sha-head-10",
      },
    },
  ]);
});

test("executeAction posts a request-changes review when Claude returns inline comments", async () => {
  const pullRequest = createPullRequest({
    number: 11,
    linkedIssueNumbers: [6],
    headSha: "sha-head-11",
  });
  const inlineComments: PullRequestInlineComment[] = [
    { path: "src/a.ts", line: 12, body: "Rename." },
    { path: "src/b.ts", line: 7, body: "Add test." },
  ];
  const harness = createHarness({
    pullRequests: [pullRequest],
    reviewSummary: "Two issues to fix.",
    reviewInlineComments: inlineComments,
  });

  await run(harness, {
    type: "review-pull-request",
    issueNumber: 6,
    pullRequestNumber: 11,
    pullRequestHeadSha: "sha-head-11",
  });

  assert.equal(harness.calls[0], "review:11");
  assert.equal(
    harness.calls[1],
    "create-review:11:sha-head-11:2-comments:Two issues to fix.",
  );
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 6,
      pullRequestNumber: 11,
      phase: "review",
      status: "completed",
      result: {
        reviewCommentCount: 2,
        pullRequestHeadSha: "sha-head-11",
      },
    },
  ]);
});

test("executeAction passes unresolved review comments to Claude and resolves threads afterwards", async () => {
  const pullRequest = createPullRequest({
    number: 12,
    linkedIssueNumbers: [9],
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    unresolvedReviewComments: [
      { path: "src/a.ts", line: 1, body: "Rename", author: "alice" },
      { path: "src/b.ts", line: 2, body: "Add test", author: "bob" },
    ],
  });

  await run(harness, {
    type: "address-review-comments",
    issueNumber: 9,
    pullRequestNumber: 12,
    pullRequestHeadSha: "sha-12",
    unresolvedReviewCommentCount: 2,
  });

  assert.deepEqual(harness.calls, [
    "list-unresolved:12",
    "address-review:12:2-comments",
    "resolve-threads:12",
  ]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 9,
      pullRequestNumber: 12,
      phase: "address-review-comments",
      status: "completed",
      result: { pullRequestHeadSha: "sha-after-address" },
    },
  ]);
});

test("executeAction passes failing check logs to Claude", async () => {
  const pullRequest = createPullRequest({
    number: 13,
    linkedIssueNumbers: [10],
    checksStatus: "failure",
    headSha: "sha-13",
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    failingCheckRuns: [
      { name: "lint", logExcerpt: "missing semicolon" },
      { name: "test", logExcerpt: "1 failing test" },
    ],
  });

  await run(harness, {
    type: "address-failing-checks",
    issueNumber: 10,
    pullRequestNumber: 13,
    pullRequestHeadSha: "sha-13",
  });

  assert.deepEqual(harness.calls, [
    "list-failing:13:sha-13",
    "address-checks:13:2-checks",
  ]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 10,
      pullRequestNumber: 13,
      phase: "address-failing-checks",
      status: "completed",
      result: { pullRequestHeadSha: "sha-after-checks" },
    },
  ]);
});

test("executeAction asks Claude to resolve merge conflicts", async () => {
  const pullRequest = createPullRequest({
    number: 14,
    linkedIssueNumbers: [11],
    hasMergeConflicts: true,
  });
  const harness = createHarness({ pullRequests: [pullRequest] });

  await run(harness, {
    type: "resolve-conflicts",
    issueNumber: 11,
    pullRequestNumber: 14,
    pullRequestHeadSha: "sha-14",
  });

  assert.deepEqual(harness.calls, ["resolve-conflicts:14"]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 11,
      pullRequestNumber: 14,
      phase: "resolve-conflicts",
      status: "completed",
      result: { pullRequestHeadSha: "sha-after-resolve" },
    },
  ]);
});

test("executeAction generates the final description, updates the PR body, and squash-merges", async () => {
  const pullRequest = createPullRequest({
    number: 15,
    linkedIssueNumbers: [3],
    closingIssueNumbers: [3],
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    generatedDescription: "Polished description",
  });

  await run(harness, {
    type: "write-final-description",
    issueNumber: 3,
    pullRequestNumber: 15,
    pullRequestTitle: "Add widget",
    pullRequestHeadRefName: "branch-15",
    closingIssueNumbers: [3],
    pullRequestBody: "Old body",
  });

  const expectedBody = "Polished description\n\nCloses #3";
  assert.deepEqual(harness.calls, [
    "generate-desc:15",
    `update-body:15:${expectedBody}`,
    `squash-merge:15:Add widget:${expectedBody}`,
  ]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 3,
      pullRequestNumber: 15,
      phase: "final-description",
      status: "completed",
      result: {
        pullRequestBody: expectedBody,
        generatedDescription: "Polished description",
      },
    },
  ]);
});

test("executeAction appends missing closing references to the generated description", async () => {
  const pullRequest = createPullRequest({
    number: 16,
    linkedIssueNumbers: [3, 8],
    closingIssueNumbers: [3, 8],
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    generatedDescription: "Summary.",
  });

  await run(harness, {
    type: "write-final-description",
    issueNumber: 3,
    pullRequestNumber: 16,
    pullRequestTitle: "Fix",
    pullRequestHeadRefName: "branch-16",
    closingIssueNumbers: [3, 8],
    pullRequestBody: "Old body",
  });

  const expectedBody = "Summary.\n\nCloses #3\n\nCloses #8";
  assert.equal(harness.calls[1], `update-body:16:${expectedBody}`);
  assert.equal(harness.calls[2], `squash-merge:16:Fix:${expectedBody}`);
});

test("executeAction is a no-op when dry-run is enabled", async () => {
  const harness = createHarness({
    issues: [createIssue({ number: 7 })],
  });

  await run(harness, { type: "start-implementation", issueNumber: 7 }, true);

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.sessions, []);
});

test("executeAction throws when start-implementation cannot find the issue in the snapshot", async () => {
  const harness = createHarness({ issues: [] });

  await assert.rejects(
    () => run(harness, { type: "start-implementation", issueNumber: 999 }),
    /Issue #999 not found/,
  );
});
