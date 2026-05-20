import test from "node:test";
import assert from "node:assert/strict";

import { buildPlan } from "../src/orchestrator.js";
import { executeAction } from "../src/actions.js";
import type {
  ActionClaudeAgentClient,
  ActionGitHubClient,
  ActionSessionStore,
  ExecuteActionContext,
} from "../src/actions.js";
import type { AgentSession, Issue, OrchestratorAction, PullRequest, RepositorySnapshot } from "../src/types.js";
import type { ProjectModeConfig } from "../src/orchestrator.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

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
    ...(overrides.parentNumber !== undefined ? { parentNumber: overrides.parentNumber } : {}),
    ...(overrides.projectStatus !== undefined ? { projectStatus: overrides.projectStatus } : {}),
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
    ...(overrides.hasNewCommentsSinceLastRead !== undefined
      ? { hasNewCommentsSinceLastRead: overrides.hasNewCommentsSinceLastRead }
      : {}),
  };
}

function createSession(
  overrides: Partial<AgentSession> & Pick<AgentSession, "id" | "issueNumber" | "phase">,
): AgentSession {
  const session: AgentSession = {
    id: overrides.id,
    issueNumber: overrides.issueNumber,
    phase: overrides.phase,
    status: overrides.status ?? "completed",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
  };
  if (overrides.pullRequestNumber !== undefined) {
    session.pullRequestNumber = overrides.pullRequestNumber;
  }
  if (overrides.result !== undefined) {
    session.result = overrides.result;
  }
  return session;
}

const projectMode: ProjectModeConfig = { projectNumber: 1, reviewers: ["alice"] };

// ─── issue filtering ─────────────────────────────────────────────────────────

test("buildPlan (project mode) only picks up issues in Ready status", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, projectStatus: "Ready" }),
      createIssue({ number: 2, projectStatus: "In Progress" }),
      createIssue({ number: 3 }), // no project status
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 1 },
  ]);
});

test("buildPlan (project mode) ignores issues with the 'manual' label", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, projectStatus: "Ready", labels: ["manual"] }),
      createIssue({ number: 2, projectStatus: "Ready" }),
    ],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 2 },
  ]);
});

// ─── no auto-merge: request-review replaces squash-merge ────────────────────

test("buildPlan (project mode) emits request-review after first clean self-review", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, projectStatus: "In Progress" })],
    pullRequests: [createPullRequest({ number: 10, linkedIssueNumbers: [1] })],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "self-review",
        result: { madeChanges: false, pullRequestHeadSha: "sha-10" },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0]!;
  assert.equal(action.type, "request-review");
  if (action.type === "request-review") {
    assert.equal(action.pullRequestNumber, 10);
    assert.deepEqual(action.reviewers, ["alice"]);
  }
});

test("buildPlan (project mode) does NOT squash-merge after two clean self-reviews", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, projectStatus: "In Progress" })],
    pullRequests: [createPullRequest({ number: 10, linkedIssueNumbers: [1] })],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "self-review",
        updatedAt: "2024-01-01T00:01:00.000Z",
        result: { madeChanges: false },
      }),
      createSession({
        id: "s2",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "self-review",
        updatedAt: "2024-01-01T00:02:00.000Z",
        result: { madeChanges: false },
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  // Should request review, not squash-merge.
  const types = plan.actions.map((a) => a.type);
  assert.ok(!types.includes("squash-merge"), "squash-merge must not appear in project mode");
  assert.ok(types.includes("request-review"), "request-review expected after clean reviews");
});

// ─── re-queue conditions ──────────────────────────────────────────────────────

test("buildPlan (project mode) re-queues self-review when PR is converted to draft", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, projectStatus: "In Review" })],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [1],
        draft: true, // PR was converted back to draft
      }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.type, "self-review");
});

test("buildPlan (project mode) re-queues self-review when there are new comments", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, projectStatus: "In Review" })],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [1],
        hasNewCommentsSinceLastRead: true,
      }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.type, "self-review");
});

test("buildPlan (project mode) re-queues self-review when issue moved back to Ready", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      // Issue moved back to "Ready" after human review
      createIssue({ number: 1, projectStatus: "Ready" }),
    ],
    pullRequests: [createPullRequest({ number: 10, linkedIssueNumbers: [1] })],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.type, "self-review");
});

test("buildPlan (project mode) does nothing while waiting for human review (no re-queue signal)", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, projectStatus: "In Review" })],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [1],
        draft: false,
        // no hasNewCommentsSinceLastRead — not set means no new comments
      }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  // No actions — waiting for human review.
  assert.deepEqual(plan.actions, []);
});

test("buildPlan (project mode) does not let PRs awaiting human review starve new issues", () => {
  // Regression: three issues are implemented and their PRs are parked
  // awaiting human review (ready-for-review). They produce no orchestrator
  // action, so they must not count against `maxConcurrency` — otherwise the
  // engine cylinders sit idle instead of picking up the remaining issues.
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, projectStatus: "In Review" }),
      createIssue({ number: 2, projectStatus: "In Review" }),
      createIssue({ number: 3, projectStatus: "In Review" }),
      createIssue({ number: 4, projectStatus: "Ready" }),
    ],
    pullRequests: [
      createPullRequest({ number: 11, linkedIssueNumbers: [1], draft: false }),
      createPullRequest({ number: 12, linkedIssueNumbers: [2], draft: false }),
      createPullRequest({ number: 13, linkedIssueNumbers: [3], draft: false }),
    ],
    agentSessions: [
      createSession({ id: "s1", issueNumber: 1, pullRequestNumber: 11, phase: "request-review" }),
      createSession({ id: "s2", issueNumber: 2, pullRequestNumber: 12, phase: "request-review" }),
      createSession({ id: "s3", issueNumber: 3, pullRequestNumber: 13, phase: "request-review" }),
    ],
  };

  const plan = buildPlan(snapshot, 3, projectMode);

  // The three parked PRs need no work; issue #4 should still be picked up.
  assert.deepEqual(plan.actions, [
    { type: "start-implementation", issueNumber: 4 },
  ]);
});

// ─── request-review action execution ─────────────────────────────────────────

test("executeAction request-review converts PR to ready, requests review, and records session", async () => {
  const calls: string[] = [];
  const sessions: Array<{ phase: string; issueNumber?: number; pullRequestNumber?: number }> = [];
  const lastReadRecords: Map<number, string> = new Map();

  const gitHubClient: ActionGitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelInProgressWorkflowRunsForHeadSha: async () => 0,
    postComment: async (prNumber, body) => {
      calls.push(`postComment:${prNumber}:${body}`);
      return 9000;
    },
    listPullRequestComments: async () => [
      { id: 1, author: "alice", body: "Looks good!", createdAt: "2024-01-02T00:00:00.000Z" },
    ],
    addEyesReaction: async (comment) => {
      calls.push(`reactEyes:${comment.id}`);
    },
    markPullRequestReadyForReview: async (prNumber) => {
      calls.push(`markReady:${prNumber}`);
    },
    requestPullRequestReview: async (prNumber, reviewers) => {
      calls.push(`requestReview:${prNumber}:${reviewers.join(",")}`);
    },
    moveIssueToProjectStatus: async (projectNumber, issueNumber, status) => {
      calls.push(`moveStatus:${issueNumber}:${status}`);
    },
  };

  const sessionStore: ActionSessionStore = {
    createSession: async (input) => {
      const entry: { phase: string; issueNumber?: number; pullRequestNumber?: number } = { phase: input.phase };
      if (input.issueNumber !== undefined) entry.issueNumber = input.issueNumber;
      if (input.pullRequestNumber !== undefined) entry.pullRequestNumber = input.pullRequestNumber;
      sessions.push(entry);
    },
    setLastReadCommentAt: async (prNumber, createdAt) => {
      lastReadRecords.set(prNumber, createdAt);
    },
  };

  const claudeAgentClient = {} as ActionClaudeAgentClient;

  const pr = {
    number: 10,
    title: "PR 10",
    body: "",
    headSha: "sha-10",
    headRefName: "branch-10",
    baseRefName: "main",
    state: "open" as const,
    draft: true, // draft PR should be converted
    hasMergeConflicts: false,
    hasCleanReviewOnHead: false,
    unresolvedReviewCommentCount: 0,
    checksStatus: "success" as const,
    headCommitPushedAt: undefined,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    labels: [],
    linkedIssueNumbers: [1],
    closingIssueNumbers: [1],
  };

  const action: OrchestratorAction = {
    type: "request-review",
    issueNumber: 1,
    pullRequestNumber: 10,
    reviewers: ["alice"],
  };

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [],
    pullRequests: [pr],
    projectMode: { projectNumber: 1, reviewers: ["alice"] },
  };

  await executeAction(gitHubClient, sessionStore, claudeAgentClient, action, false, context);

  // Should convert PR from draft to ready.
  assert.ok(calls.includes("markReady:10"), "expected markPullRequestReadyForReview to be called");

  // Should request review.
  assert.ok(calls.includes("requestReview:10:alice"), "expected requestPullRequestReview to be called");

  // Should move issue to In Review.
  assert.ok(calls.includes("moveStatus:1:In Review"), "expected moveIssueToProjectStatus to be called");

  // Should post a comment.
  const commentCall = calls.find((c) => c.startsWith("postComment:10:"));
  assert.ok(commentCall, "expected a comment to be posted");

  // Should record last-read comment timestamp.
  assert.equal(lastReadRecords.get(10), "2024-01-02T00:00:00.000Z");

  // Should create a session with phase=request-review.
  assert.ok(
    sessions.some((s) => s.phase === "request-review" && s.pullRequestNumber === 10),
    "expected a request-review session to be recorded",
  );
});

test("executeAction start-implementation moves issue to In Progress in project mode", async () => {
  const calls: string[] = [];
  const sessions: Array<{ phase: string }> = [];

  const gitHubClient: ActionGitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelInProgressWorkflowRunsForHeadSha: async () => 0,
    postComment: async () => 9001,
    listPullRequestComments: async () => [],
    addEyesReaction: async () => {},
    moveIssueToProjectStatus: async (projectNumber, issueNumber, status) => {
      calls.push(`moveStatus:${projectNumber}:${issueNumber}:${status}`);
    },
  };

  const sessionStore: ActionSessionStore = {
    createSession: async (input) => {
      sessions.push({ phase: input.phase });
    },
  };

  const claudeAgentClient: ActionClaudeAgentClient = {
    implementIssue: async () => ({
      branch: "my-branch",
      pullRequestTitle: "My PR",
      pullRequestBody: "body",
      headSha: "sha",
    }),
    selfReview: async () => ({ madeChanges: false, headSha: "sha" }),
    resolveMergeConflicts: async () => ({ headSha: "sha" }),
    addressFailingChecks: async () => ({ headSha: "sha" }),
    generateFinalDescription: async () => "description",
  };

  const action: OrchestratorAction = {
    type: "start-implementation",
    issueNumber: 1,
  };

  const issue: Issue = {
    number: 1,
    title: "My Issue",
    body: "body",
    state: "open",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    type: null,
    labels: [],
  };

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [issue],
    pullRequests: [],
    projectMode: { projectNumber: 42, reviewers: [] },
  };

  await executeAction(gitHubClient, sessionStore, claudeAgentClient, action, false, context);

  // Should move issue to In Progress before implementing.
  assert.ok(
    calls.includes("moveStatus:42:1:In Progress"),
    "expected moveIssueToProjectStatus(42, 1, 'In Progress') to be called",
  );
});

// ─── last-read comment persistence ───────────────────────────────────────────

test("executeAction self-review records the latest comment timestamp as last-read", async () => {
  const lastReadRecords: Map<number, string> = new Map();

  const gitHubClient: ActionGitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelInProgressWorkflowRunsForHeadSha: async () => 0,
    postComment: async () => 9002,
    listPullRequestComments: async () => [
      { id: 1, author: "bob", body: "Please fix X", createdAt: "2024-01-01T00:01:00.000Z" },
      { id: 2, author: "carol", body: "Also Y", createdAt: "2024-01-01T00:02:00.000Z" },
    ],
    addEyesReaction: async () => {},
  };

  const sessionStore: ActionSessionStore = {
    createSession: async () => {},
    setLastReadCommentAt: async (prNumber, createdAt) => {
      lastReadRecords.set(prNumber, createdAt);
    },
  };

  const claudeAgentClient: ActionClaudeAgentClient = {
    implementIssue: async () => ({ branch: "", pullRequestTitle: "", pullRequestBody: "", headSha: "" }),
    selfReview: async () => ({ madeChanges: false, headSha: "sha" }),
    resolveMergeConflicts: async () => ({ headSha: "" }),
    addressFailingChecks: async () => ({ headSha: "" }),
    generateFinalDescription: async () => "",
  };

  const pr: PullRequest = {
    number: 10,
    title: "PR 10",
    body: "",
    headSha: "sha-10",
    headRefName: "branch-10",
    baseRefName: "main",
    state: "open",
    draft: false,
    hasMergeConflicts: false,
    hasCleanReviewOnHead: false,
    unresolvedReviewCommentCount: 0,
    checksStatus: "success",
    headCommitPushedAt: undefined,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    labels: [],
    linkedIssueNumbers: [1],
    closingIssueNumbers: [1],
  };

  const action: OrchestratorAction = {
    type: "self-review",
    issueNumber: 1,
    pullRequestNumber: 10,
    pullRequestHeadSha: "sha-10",
  };

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [],
    pullRequests: [pr],
  };

  await executeAction(gitHubClient, sessionStore, claudeAgentClient, action, false, context);

  // The latest comment is from carol at 2024-01-01T00:02:00.000Z.
  assert.equal(lastReadRecords.get(10), "2024-01-01T00:02:00.000Z");
});
