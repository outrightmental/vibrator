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
  capturedUserComments: Array<Array<{ author: string; body: string; createdAt: string }>>;
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
    labels: overrides.labels ?? [],
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
    headCommitPushedAt: overrides.headCommitPushedAt,
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    labels: overrides.labels ?? [],
    linkedIssueNumbers: overrides.linkedIssueNumbers,
    closingIssueNumbers: overrides.closingIssueNumbers ?? overrides.linkedIssueNumbers,
  };
}

function createHarness(input: {
  issues?: Issue[];
  pullRequests?: PullRequest[];
  selfReviewMadeChanges?: boolean;
  selfReviewHeadSha?: string;
  selfReviewCommentResponses?: Array<{ index: number; response: string }>;
  generatedDescription?: string;
  implementation?: {
    branch: string;
    pullRequestTitle: string;
    pullRequestBody: string;
    headSha: string;
  };
  failingCheckRuns?: Array<{ name: string; logExcerpt: string }>;
  newPullRequest?: { number: number; headSha: string; created?: boolean };
  pullRequestComments?: Array<{
    author: string;
    body: string;
    createdAt: string;
    url?: string;
    kind?: string;
  }>;
}): Harness {
  const calls: string[] = [];
  const sessions: SessionInput[] = [];
  const capturedUserComments: Array<Array<{ author: string; body: string; createdAt: string }>> = [];
  const newPullRequest: { number: number; headSha: string; created: boolean } = {
    ...input.newPullRequest,
    number: input.newPullRequest?.number ?? 999,
    headSha: input.newPullRequest?.headSha ?? "sha-new",
    created: input.newPullRequest?.created ?? true,
  };

  const gitHubClient: ActionGitHubClient = {
    async getDefaultBranch(): Promise<string> {
      calls.push("get-default-branch");
      return "main";
    },
    async createPullRequest(args): Promise<{ number: number; headSha: string; created: boolean }> {
      calls.push(
        `create-pr:${args.head}->${args.base}:draft=${args.draft ?? false}:${args.title}:${args.body.replace(/\n/g, "\\n")}`,
      );
      return newPullRequest;
    },
    async updatePullRequestBody(pullRequestNumber, body): Promise<void> {
      calls.push(`update-body:${pullRequestNumber}:${body}`);
    },
    async squashMergePullRequest(pullRequestNumber, subject, body): Promise<void> {
      calls.push(`squash-merge:${pullRequestNumber}:${subject}:${body}`);
    },
    async markPullRequestReadyForReview(pullRequestNumber): Promise<void> {
      calls.push(`mark-ready:${pullRequestNumber}`);
    },
    async listFailingCheckRuns(args) {
      calls.push(`list-failing:${args.pullRequestNumber}:${args.headSha}`);
      return input.failingCheckRuns ?? [];
    },
    async cancelInProgressWorkflowRunsForHeadSha(headSha) {
      calls.push(`cancel-in-progress:${headSha}`);
      return 0;
    },
    async postComment(pullRequestNumber, body) {
      calls.push(`post-comment:${pullRequestNumber}:${body}`);
    },
    async listPullRequestComments(_pullRequestNumber) {
      return input.pullRequestComments ?? [];
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
    async selfReview(params) {
      calls.push(`self-review:${params.pullRequestNumber}`);
      if (params.userComments) capturedUserComments.push([...params.userComments]);
      return {
        madeChanges: input.selfReviewMadeChanges ?? false,
        headSha: input.selfReviewHeadSha ?? "sha-after-self-review",
        ...(input.selfReviewCommentResponses && {
          commentResponses: input.selfReviewCommentResponses,
        }),
      };
    },
    async resolveMergeConflicts(params) {
      calls.push(`resolve-conflicts:${params.pullRequestNumber}`);
      if (params.userComments) capturedUserComments.push([...params.userComments]);
      return { headSha: "sha-after-resolve" };
    },
    async addressFailingChecks(params) {
      calls.push(
        `address-checks:${params.pullRequestNumber}:${params.failingChecks.length}-checks`,
      );
      if (params.userComments) capturedUserComments.push([...params.userComments]);
      return { headSha: "sha-after-checks" };
    },
    async generateFinalDescription(params) {
      calls.push(`generate-desc:${params.pullRequestNumber}`);
      return input.generatedDescription ?? "Final description.";
    },
  };

  return {
    calls,
    sessions,
    capturedUserComments,
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
    newPullRequest: { number: 100, headSha: "sha-impl-7", created: true },
  });

  await run(harness, { type: "start-implementation", issueNumber: 7 });

  assert.deepEqual(harness.calls, [
    "get-default-branch",
    "implement:7:main",
    "create-pr:vibrator/issue-7-add-widget->main:draft=true:Add widget:Added widget.\\n\\nCloses #7",
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

test("executeAction backfills the closing reference when reusing an existing PR", async () => {
  const harness = createHarness({
    issues: [createIssue({ number: 7, title: "Add widget", body: "Make it." })],
    pullRequests: [
      createPullRequest({
        number: 100,
        linkedIssueNumbers: [7],
        headRefName: "vibrator/issue-7-add-widget",
        body: "Added widget.",
      }),
    ],
    implementation: {
      branch: "vibrator/issue-7-add-widget",
      pullRequestTitle: "Add widget",
      pullRequestBody: "Added widget.",
      headSha: "sha-impl-7",
    },
    newPullRequest: { number: 100, headSha: "sha-impl-7", created: false },
  });

  await run(harness, { type: "start-implementation", issueNumber: 7 });

  assert.deepEqual(harness.calls, [
    "get-default-branch",
    "implement:7:main",
    "create-pr:vibrator/issue-7-add-widget->main:draft=true:Add widget:Added widget.\\n\\nCloses #7",
    "update-body:100:Added widget.\n\nCloses #7",
  ]);
  assert.deepEqual(harness.sessions, []);
});

test("executeAction runs a self-review and records whether changes were made", async () => {
  const pullRequest = createPullRequest({
    number: 10,
    linkedIssueNumbers: [5],
    headSha: "sha-head-10",
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    selfReviewMadeChanges: false,
    selfReviewHeadSha: "sha-after-self-review",
  });

  await run(harness, {
    type: "self-review",
    issueNumber: 5,
    pullRequestNumber: 10,
    pullRequestHeadSha: "sha-head-10",
  });

  assert.deepEqual(harness.calls, ["self-review:10", "post-comment:10:Reviewed code, no issues found."]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 5,
      pullRequestNumber: 10,
      phase: "self-review",
      status: "completed",
      result: {
        madeChanges: false,
        pullRequestHeadSha: "sha-after-self-review",
      },
    },
  ]);
});

test("executeAction records madeChanges=true when the self-review commits changes", async () => {
  const pullRequest = createPullRequest({
    number: 11,
    linkedIssueNumbers: [6],
    headSha: "sha-head-11",
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    selfReviewMadeChanges: true,
    selfReviewHeadSha: "sha-after-fixes",
  });

  await run(harness, {
    type: "self-review",
    issueNumber: 6,
    pullRequestNumber: 11,
    pullRequestHeadSha: "sha-head-11",
  });

  assert.deepEqual(harness.calls, ["self-review:11", "post-comment:11:Reviewed code and pushed fixes."]);
  assert.deepEqual(harness.sessions, [
    {
      issueNumber: 6,
      pullRequestNumber: 11,
      phase: "self-review",
      status: "completed",
      result: {
        madeChanges: true,
        pullRequestHeadSha: "sha-after-fixes",
      },
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
    "cancel-in-progress:sha-13",
    "list-failing:13:sha-13",
    "address-checks:13:2-checks",
    "post-comment:13:Addressed failing CI checks and pushed a fix (lint, test).",
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

  assert.deepEqual(harness.calls, ["resolve-conflicts:14", "post-comment:14:Resolved merge conflicts and pushed updated branch."]);

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
    headRefName: "branch-15",
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    generatedDescription: "Polished description",
  });

  await run(harness, {
    type: "squash-merge",
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
      phase: "squash-merge",
      status: "completed",
      result: { pullRequestBody: expectedBody },
    },
  ]);
});

test("executeAction appends missing closing references to the generated description on merge", async () => {
  const pullRequest = createPullRequest({
    number: 16,
    linkedIssueNumbers: [3, 8],
    closingIssueNumbers: [3, 8],
    headRefName: "branch-16",
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    generatedDescription: "Summary.",
  });

  await run(harness, {
    type: "squash-merge",
    issueNumber: 3,
    pullRequestNumber: 16,
    pullRequestTitle: "Fix",
    pullRequestHeadRefName: "branch-16",
    closingIssueNumbers: [3, 8],
    pullRequestBody: "Old body",
  });

  const expectedBody = "Summary.\n\nCloses #3\n\nCloses #8";
  assert.equal(harness.calls[0], "generate-desc:16");
  assert.equal(harness.calls[1], `update-body:16:${expectedBody}`);
  assert.equal(harness.calls[2], `squash-merge:16:Fix:${expectedBody}`);
  assert.equal(harness.calls.length, 3);
});

test("executeAction marks a draft PR ready-for-review before squash-merging", async () => {
  const pullRequest = createPullRequest({
    number: 17,
    linkedIssueNumbers: [4],
    closingIssueNumbers: [4],
    headRefName: "branch-17",
    draft: true,
  });
  const harness = createHarness({
    pullRequests: [pullRequest],
    generatedDescription: "Polished description",
  });

  await run(harness, {
    type: "squash-merge",
    issueNumber: 4,
    pullRequestNumber: 17,
    pullRequestTitle: "Add gizmo",
    pullRequestHeadRefName: "branch-17",
    closingIssueNumbers: [4],
    pullRequestBody: "Old body",
  });

  const expectedBody = "Polished description\n\nCloses #4";
  assert.deepEqual(harness.calls, [
    "generate-desc:17",
    `update-body:17:${expectedBody}`,
    "mark-ready:17",
    `squash-merge:17:Add gizmo:${expectedBody}`,
  ]);
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

test("executeAction passes PR comments to selfReview", async () => {
  const pullRequest = createPullRequest({ number: 20, linkedIssueNumbers: [5] });
  const comments = [
    { author: "alice", body: "Please add more tests", createdAt: "2024-02-01T10:00:00.000Z" },
  ];
  const harness = createHarness({
    pullRequests: [pullRequest],
    issues: [createIssue({ number: 5 })],
    pullRequestComments: comments,
  });

  await run(harness, {
    type: "self-review",
    issueNumber: 5,
    pullRequestNumber: 20,
    pullRequestHeadSha: "sha-20",
  });

  assert.equal(harness.capturedUserComments.length, 1);
  assert.deepEqual(harness.capturedUserComments[0], comments);
});

test("executeAction's self-review comment acknowledges every parsed human comment", async () => {
  const pullRequest = createPullRequest({ number: 25, linkedIssueNumbers: [5] });
  const comments = [
    {
      author: "alice",
      body: "Implement the favicon",
      createdAt: "2024-02-01T10:00:00.000Z",
      url: "https://github.com/o/r/pull/25#pullrequestreview-1",
      kind: "review",
    },
    {
      author: "bob",
      body: "Add tests",
      createdAt: "2024-02-02T10:00:00.000Z",
      url: "https://github.com/o/r/pull/25#issuecomment-2",
      kind: "conversation",
    },
  ];
  const harness = createHarness({
    pullRequests: [pullRequest],
    issues: [createIssue({ number: 5 })],
    pullRequestComments: comments,
    selfReviewMadeChanges: true,
    selfReviewCommentResponses: [
      { index: 1, response: "Unzipped the favicon assets and added the header tags." },
      { index: 2, response: "Added unit tests covering the new code path." },
    ],
  });

  await run(harness, {
    type: "self-review",
    issueNumber: 5,
    pullRequestNumber: 25,
    pullRequestHeadSha: "sha-25",
  });

  const postCall = harness.calls.find((c) => c.startsWith("post-comment:25:"));
  assert.ok(postCall, "should post a review comment");
  const body = postCall.slice("post-comment:25:".length);
  assert.ok(body.includes("Reviewed code and pushed fixes."), "includes the review summary");
  assert.ok(
    body.includes(
      "I read and addressed the comment from @alice (https://github.com/o/r/pull/25#pullrequestreview-1): " +
        "Unzipped the favicon assets and added the header tags.",
    ),
    "acknowledges alice's review comment with its per-comment narrative",
  );
  assert.ok(
    body.includes(
      "I read and addressed the comment from @bob (https://github.com/o/r/pull/25#issuecomment-2): " +
        "Added unit tests covering the new code path.",
    ),
    "acknowledges bob's comment with its per-comment narrative",
  );
});

test("executeAction's self-review comment falls back gracefully when the agent emits no payload", async () => {
  const pullRequest = createPullRequest({ number: 26, linkedIssueNumbers: [5] });
  const harness = createHarness({
    pullRequests: [pullRequest],
    issues: [createIssue({ number: 5 })],
    pullRequestComments: [
      {
        author: "alice",
        body: "Implement the favicon",
        createdAt: "2024-02-01T10:00:00.000Z",
        url: "https://github.com/o/r/pull/26#pullrequestreview-1",
        kind: "review",
      },
    ],
    selfReviewMadeChanges: false,
  });

  await run(harness, {
    type: "self-review",
    issueNumber: 5,
    pullRequestNumber: 26,
    pullRequestHeadSha: "sha-26",
  });

  const postCall = harness.calls.find((c) => c.startsWith("post-comment:26:"));
  assert.ok(postCall, "should post a review comment");
  const body = postCall.slice("post-comment:26:".length);
  assert.ok(
    body.includes(
      "I read the comment from @alice: https://github.com/o/r/pull/26#pullrequestreview-1 " +
        "(no per-comment summary was produced).",
    ),
    "still acknowledges the comment when no payload was emitted",
  );
});

test("executeAction passes PR comments to addressFailingChecks", async () => {
  const pullRequest = createPullRequest({
    number: 21,
    linkedIssueNumbers: [],
    checksStatus: "failure",
  });
  const comments = [
    { author: "bob", body: "The lint step is misconfigured", createdAt: "2024-02-02T08:00:00.000Z" },
  ];
  const harness = createHarness({
    pullRequests: [pullRequest],
    pullRequestComments: comments,
  });

  await run(harness, {
    type: "address-failing-checks",
    issueNumber: undefined,
    pullRequestNumber: 21,
    pullRequestHeadSha: "sha-21",
  });

  assert.equal(harness.capturedUserComments.length, 1);
  assert.deepEqual(harness.capturedUserComments[0], comments);
});

test("executeAction passes PR comments to resolveMergeConflicts", async () => {
  const pullRequest = createPullRequest({
    number: 22,
    linkedIssueNumbers: [],
    hasMergeConflicts: true,
  });
  const comments = [
    { author: "carol", body: "Keep the new API signature", createdAt: "2024-02-03T09:00:00.000Z" },
  ];
  const harness = createHarness({
    pullRequests: [pullRequest],
    pullRequestComments: comments,
  });

  await run(harness, {
    type: "resolve-conflicts",
    issueNumber: undefined,
    pullRequestNumber: 22,
    pullRequestHeadSha: "sha-22",
  });

  assert.equal(harness.capturedUserComments.length, 1);
  assert.deepEqual(harness.capturedUserComments[0], comments);
});
