import test from "node:test";
import assert from "node:assert/strict";

import { buildPlan, REVIEW_LABEL } from "../src/orchestrator.js";
import { executeAction } from "../src/actions.js";
import type {
  ActionClaudeAgentClient,
  ActionGitHubClient,
  ActionSessionStore,
  ExecuteActionContext,
} from "../src/actions.js";
import type { AgentSession, Issue, OrchestratorAction, PullRequest, RepositorySnapshot } from "../src/types.js";

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

/** A PR on issue 1 whose latest completed session is a clean self-review. */
function cleanSelfReviewSnapshot(overrides: {
  issueLabels?: string[];
  pullRequestLabels?: string[];
  issues?: Issue[];
}): RepositorySnapshot {
  return {
    issues: overrides.issues ?? [createIssue({ number: 1, labels: overrides.issueLabels ?? [] })],
    pullRequests: [
      createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: overrides.pullRequestLabels ?? [] }),
    ],
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
}

// ─── planning: never merge, request review instead ───────────────────────────

test("buildPlan still picks up review-labelled issues for implementation", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [{ type: "start-implementation", issueNumber: 1 }]);
});

test("buildPlan emits request-review (no reviewers) after one clean self-review on a review-labelled issue", () => {
  const plan = buildPlan(cleanSelfReviewSnapshot({ issueLabels: [REVIEW_LABEL] }), 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
  ]);
});

test("buildPlan without the review label runs a second self-review after one clean pass (unchanged)", () => {
  const plan = buildPlan(cleanSelfReviewSnapshot({}), 3);

  assert.deepEqual(plan.actions, [
    { type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

test("buildPlan never squash-merges a review-gated PR, even after two clean self-reviews", () => {
  const snapshot = cleanSelfReviewSnapshot({ issueLabels: [REVIEW_LABEL] });
  snapshot.agentSessions.push(
    createSession({
      id: "s2",
      issueNumber: 1,
      pullRequestNumber: 10,
      phase: "self-review",
      updatedAt: "2024-01-02T00:00:00.000Z",
      result: { madeChanges: false, pullRequestHeadSha: "sha-10" },
    }),
  );

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
  ]);
});

test("buildPlan honors the review label on the PR itself, even when the issue is gone", () => {
  const snapshot = cleanSelfReviewSnapshot({ pullRequestLabels: [REVIEW_LABEL], issues: [] });

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
  ]);
});

// ─── parking: the final PR is left for the human ─────────────────────────────

test("buildPlan parks a review-gated PR after request-review and frees its cylinder", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, labels: [REVIEW_LABEL] }),
      createIssue({ number: 2, createdAt: "2024-01-02T00:00:00.000Z" }),
    ],
    pullRequests: [createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: [REVIEW_LABEL] })],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  // With a single cylinder, the parked PR must not starve issue 2.
  const plan = buildPlan(snapshot, 1);

  assert.deepEqual(plan.actions, [{ type: "start-implementation", issueNumber: 2 }]);
});

test("buildPlan re-queues a review-gated PR converted back to draft", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [
      createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: [REVIEW_LABEL], draft: true }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

test("buildPlan re-queues a review-gated PR with new human comments", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [1],
        labels: [REVIEW_LABEL],
        hasNewCommentsSinceLastRead: true,
      }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

// ─── actions: label propagation and review request without reviewers ─────────

test("executeAction start-implementation copies the review label onto the new PR", async () => {
  const labeled: Array<{ pullRequestNumber: number; labels: string[] }> = [];

  const gitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelInProgressWorkflowRunsForHeadSha: async () => 0,
    postComment: async () => 9000,
    listPullRequestComments: async () => [],
    addEyesReaction: async () => {},
    addLabelsToPullRequest: async (pullRequestNumber: number, labels: string[]) => {
      labeled.push({ pullRequestNumber, labels });
    },
  } satisfies ActionGitHubClient;

  const sessions: Array<{ phase: string }> = [];
  const sessionStore: ActionSessionStore = {
    createSession: async (input) => {
      sessions.push({ phase: input.phase });
    },
  };

  const claudeAgentClient = {
    implementIssue: async () => ({
      branch: "my-branch",
      pullRequestTitle: "My PR",
      pullRequestBody: "body",
      headSha: "sha",
    }),
  } as unknown as ActionClaudeAgentClient;

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [],
  };

  const action: OrchestratorAction = { type: "start-implementation", issueNumber: 1 };
  await executeAction(gitHubClient, sessionStore, claudeAgentClient, action, false, context);

  assert.deepEqual(labeled, [{ pullRequestNumber: 10, labels: [REVIEW_LABEL] }]);
  assert.ok(sessions.some((s) => s.phase === "implementation"));
});

test("executeAction start-implementation leaves unlabelled issues alone", async () => {
  const labeled: string[] = [];

  const gitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelInProgressWorkflowRunsForHeadSha: async () => 0,
    postComment: async () => 9000,
    listPullRequestComments: async () => [],
    addEyesReaction: async () => {},
    addLabelsToPullRequest: async () => {
      labeled.push("called");
    },
  } satisfies ActionGitHubClient;

  const sessionStore: ActionSessionStore = { createSession: async () => {} };
  const claudeAgentClient = {
    implementIssue: async () => ({
      branch: "my-branch",
      pullRequestTitle: "My PR",
      pullRequestBody: "body",
      headSha: "sha",
    }),
  } as unknown as ActionClaudeAgentClient;

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [createIssue({ number: 1 })],
    pullRequests: [],
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    claudeAgentClient,
    { type: "start-implementation", issueNumber: 1 },
    false,
    context,
  );

  assert.deepEqual(labeled, []);
});

test("executeAction request-review with no reviewers marks ready without requesting or moving status", async () => {
  const calls: string[] = [];
  const sessions: Array<{ phase: string; pullRequestNumber?: number }> = [];

  const gitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelInProgressWorkflowRunsForHeadSha: async () => 0,
    postComment: async (prNumber: number, body: string) => {
      calls.push(`postComment:${prNumber}:${body}`);
      return 9000;
    },
    listPullRequestComments: async () => [],
    addEyesReaction: async () => {},
    markPullRequestReadyForReview: async (prNumber: number) => {
      calls.push(`markReady:${prNumber}`);
    },
    requestPullRequestReview: async (prNumber: number, reviewers: string[]) => {
      calls.push(`requestReview:${prNumber}:${reviewers.join(",")}`);
    },
    moveIssueToProjectStatus: async (_p: number, issueNumber: number, status: string) => {
      calls.push(`moveStatus:${issueNumber}:${status}`);
    },
  } satisfies ActionGitHubClient;

  const sessionStore: ActionSessionStore = {
    createSession: async (input) => {
      const entry: { phase: string; pullRequestNumber?: number } = { phase: input.phase };
      if (input.pullRequestNumber !== undefined) entry.pullRequestNumber = input.pullRequestNumber;
      sessions.push(entry);
    },
    setLastReadCommentAt: async () => {},
  };

  const claudeAgentClient = {} as ActionClaudeAgentClient;

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [
      createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: [REVIEW_LABEL], draft: true }),
    ],
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    claudeAgentClient,
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
    false,
    context,
  );

  assert.ok(calls.includes("markReady:10"), "expected the PR to be marked ready for review");
  assert.ok(
    !calls.some((c) => c.startsWith("requestReview:")),
    "expected no reviewer request when reviewers is empty",
  );
  assert.ok(
    !calls.some((c) => c.startsWith("moveStatus:")),
    "expected no project-board move outside project mode",
  );
  assert.ok(
    sessions.some((s) => s.phase === "request-review" && s.pullRequestNumber === 10),
    "expected a request-review session to be recorded",
  );
});
