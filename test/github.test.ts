import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitHubClient,
  isVibratorReview,
  loadSnapshot,
  VIBRATOR_COMMENT_MARKER,
  VIBRATOR_REVIEW_MARKER,
} from "../src/github.js";
import { FileSessionStore } from "../src/session-store.js";

function captureStderr(t: test.TestContext): { output: () => string } {
  let stderrOutput = "";
  const stderrWriteMock = t.mock.method(
    process.stderr,
    "write",
    (chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  );
  t.after(() => {
    stderrWriteMock.mock.restore();
  });
  return {
    output: () => stderrOutput,
  };
}

test("isVibratorReview returns true when the review body carries the marker", () => {
  assert.equal(
    isVibratorReview(`${VIBRATOR_REVIEW_MARKER}\n\nLooks good.`),
    true,
  );
});

test("isVibratorReview returns false for reviews from other sources", () => {
  assert.equal(isVibratorReview("LGTM"), false);
  assert.equal(isVibratorReview(null), false);
  assert.equal(isVibratorReview(undefined), false);
});

test("squashMergePullRequest retries with --admin when branch policy blocks merge", async (t) => {
  const stderr = captureStderr(t);
  const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  let mergeAttempts = 0;

  const spawnMock = t.mock.method(
    childProcess,
    "spawn",
    (command: string, args: readonly string[]) => {
      spawnCalls.push({ command, args });

      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        if (args[1] === "ready") {
          child.emit("close", 0);
          return;
        }

        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          child.stderr.emit(
            "data",
            "X Pull request outrightmental/readtheroom#160 is not mergeable: the base branch policy prohibits the merge.\n" +
              "To use administrator privileges to immediately merge the pull request, add the `--admin` flag.\n",
          );
          child.emit("close", 1);
          return;
        }

        child.emit("close", 0);
      });

      return child;
    },
  );

  t.after(() => {
    spawnMock.mock.restore();
  });

  const client = new GitHubClient({
    owner: "outrightmental",
    repo: "readtheroom",
    token: "token",
  });

  await client.squashMergePullRequest(160, "Subject", "Body");

  assert.equal(spawnCalls.length, 3);
  assert.deepEqual(spawnCalls[1]?.args, [
    "pr",
    "merge",
    "160",
    "--squash",
    "--subject",
    "Subject",
    "--body",
    "Body",
    "--repo",
    "outrightmental/readtheroom",
  ]);
  assert.deepEqual(spawnCalls[2]?.args, [
    "pr",
    "merge",
    "160",
    "--squash",
    "--subject",
    "Subject",
    "--body",
    "Body",
    "--repo",
    "outrightmental/readtheroom",
    "--admin",
  ]);
  assert.match(stderr.output(), /base branch policy prohibits the merge/);
});

test("squashMergePullRequest does not retry unrelated gh merge failures", async (t) => {
  const stderr = captureStderr(t);
  const spawnMock = t.mock.method(
    childProcess,
    "spawn",
    (_command: string, args: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        if (args[1] === "ready") {
          child.emit("close", 0);
          return;
        }

        child.stderr.emit("data", "network failure\n");
        child.emit("close", 1);
      });

      return child;
    },
  );

  t.after(() => {
    spawnMock.mock.restore();
  });

  const client = new GitHubClient({
    owner: "outrightmental",
    repo: "readtheroom",
    token: "token",
  });

  await assert.rejects(
    client.squashMergePullRequest(160, "Subject", "Body"),
    /non-zero status 1/,
  );
  assert.match(stderr.output(), /network failure/);
});

test("listOpenIssues falls back gracefully when parent-numbers GraphQL query fails", async (t) => {
  const warnOutput: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnOutput.push(args.map(String).join(" "));
  });

  let fetchCallCount = 0;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      fetchCallCount += 1;
      const url = String(_url);

      // REST issue list: return two issues
      if (url.includes("/issues?") && !url.includes("/graphql")) {
        return new Response(
          JSON.stringify([
            {
              number: 5,
              title: "Issue five",
              body: "body",
              state: "open",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
            },
            {
              number: 6,
              title: "Issue six",
              body: "body",
              state: "open",
              created_at: "2024-01-02T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // GraphQL parent-numbers query: simulate schema error (field not available)
      if (url.includes("/graphql")) {
        return new Response(
          JSON.stringify({
            errors: [{ message: "Field 'parent' doesn't exist on type 'Issue'" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch call to ${url}`);
    },
  );

  t.after(() => {
    fetchMock.mock.restore();
  });

  const client = new GitHubClient({
    owner: "outrightmental",
    repo: "testrepo",
    token: "token",
  });

  const issues = await client.listOpenIssues();

  // Issues are returned without parent numbers
  assert.equal(issues.length, 2);
  assert.equal(issues[0]?.number, 5);
  assert.equal(issues[0]?.parentNumber, undefined);
  assert.equal(issues[1]?.number, 6);
  assert.equal(issues[1]?.parentNumber, undefined);

  // A warning was emitted explaining the degradation
  assert.ok(
    warnOutput.some((line) => line.includes("Could not fetch issue parent numbers")),
    "Expected a warning about parent numbers being unavailable",
  );
});

/**
 * Builds a fetch mock that serves the three GitHub endpoints
 * listPullRequestComments reads: issue conversation comments, PR reviews, and
 * inline review-thread comments.
 */
function mockPrCommentEndpoints(
  t: test.TestContext,
  prNumber: number,
  data: {
    issueComments?: unknown[];
    reviews?: unknown[];
    reviewThreadComments?: unknown[];
  },
): void {
  const json = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request): Promise<Response> => {
      const url = String(_url);
      if (url.includes(`/issues/${prNumber}/comments`)) return json(data.issueComments ?? []);
      if (url.includes(`/pulls/${prNumber}/reviews`)) return json(data.reviews ?? []);
      if (url.includes(`/pulls/${prNumber}/comments`)) return json(data.reviewThreadComments ?? []);
      throw new Error(`Unexpected fetch call to ${url}`);
    },
  );
  t.after(() => {
    fetchMock.mock.restore();
  });
}

test("listPullRequestComments excludes Vibrator's own marked comments but keeps human comments on a shared account", async (t) => {
  // Vibrator runs under the same account ("charneykaye") as the human
  // reviewer, so its own comments must be told apart by the hidden marker —
  // not by author login.
  mockPrCommentEndpoints(t, 42, {
    issueComments: [
      {
        user: { login: "charneykaye", type: "User" },
        body: `Reviewed code, no issues found.\n\n${VIBRATOR_COMMENT_MARKER}`,
        created_at: "2024-03-01T10:00:00Z",
        html_url: "https://github.com/o/r/pull/42#issuecomment-1",
      },
      {
        user: { login: "charneykaye", type: "User" },
        body: "Please add more tests",
        created_at: "2024-03-02T09:00:00Z",
        html_url: "https://github.com/o/r/pull/42#issuecomment-2",
      },
      {
        user: { login: "github-actions", type: "Bot" },
        body: "Visit the preview URL for this PR",
        created_at: "2024-03-02T09:30:00Z",
        html_url: "https://github.com/o/r/pull/42#issuecomment-3",
      },
    ],
  });

  const client = new GitHubClient({ owner: "outrightmental", repo: "testrepo", token: "token" });
  const comments = await client.listPullRequestComments(42);

  // Vibrator's own marked comment and the github-actions bot comment are
  // dropped; the human's comment survives despite sharing the login.
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.author, "charneykaye");
  assert.equal(comments[0]?.body, "Please add more tests");
  assert.equal(comments[0]?.kind, "conversation");
  assert.equal(comments[0]?.url, "https://github.com/o/r/pull/42#issuecomment-2");
});

test("listPullRequestComments includes PR reviews and inline review-thread comments", async (t) => {
  mockPrCommentEndpoints(t, 7, {
    issueComments: [
      {
        user: { login: "alice", type: "User" },
        body: "Looks promising",
        created_at: "2024-03-01T08:00:00Z",
        html_url: "https://github.com/o/r/pull/7#issuecomment-1",
      },
    ],
    reviews: [
      {
        user: { login: "alice", type: "User" },
        body: "You haven't implemented the favicon yet.",
        submitted_at: "2024-03-02T08:00:00Z",
        html_url: "https://github.com/o/r/pull/7#pullrequestreview-1",
      },
      // Bare review with no body — skipped (its inline comments come separately).
      {
        user: { login: "alice", type: "User" },
        body: "",
        submitted_at: "2024-03-02T08:05:00Z",
        html_url: "https://github.com/o/r/pull/7#pullrequestreview-2",
      },
      // Vibrator's own posted review — excluded via the review marker.
      {
        user: { login: "alice", type: "User" },
        body: `${VIBRATOR_REVIEW_MARKER}\n\nAutomated review.`,
        submitted_at: "2024-03-02T08:10:00Z",
        html_url: "https://github.com/o/r/pull/7#pullrequestreview-3",
      },
    ],
    reviewThreadComments: [
      {
        user: { login: "alice", type: "User" },
        body: "This variable name is unclear",
        created_at: "2024-03-03T08:00:00Z",
        html_url: "https://github.com/o/r/pull/7#discussion_r1",
      },
    ],
  });

  const client = new GitHubClient({ owner: "outrightmental", repo: "testrepo", token: "token" });
  const comments = await client.listPullRequestComments(7);

  // Conversation comment, review summary, and review-thread comment — sorted
  // by creation time. The empty review and Vibrator's own review are excluded.
  assert.equal(comments.length, 3);
  assert.deepEqual(
    comments.map((c) => c.kind),
    ["conversation", "review", "review-thread"],
  );
  assert.equal(comments[1]?.body, "You haven't implemented the favicon yet.");
  assert.equal(comments[1]?.kind, "review");
});

test("listPullRequestComments returns empty array when there is no human feedback", async (t) => {
  mockPrCommentEndpoints(t, 10, {
    issueComments: [
      {
        user: { login: "charneykaye", type: "User" },
        body: `Addressed failing CI checks.\n\n${VIBRATOR_COMMENT_MARKER}`,
        created_at: "2024-03-01T10:00:00Z",
        html_url: "https://github.com/o/r/pull/10#issuecomment-1",
      },
    ],
  });

  const client = new GitHubClient({ owner: "outrightmental", repo: "testrepo", token: "token" });
  const comments = await client.listPullRequestComments(10);
  assert.equal(comments.length, 0);
});

test("listPullRequestComments excludes comment ids passed in excludeCommentIds", async (t) => {
  mockPrCommentEndpoints(t, 50, {
    issueComments: [
      {
        id: 7001,
        user: { login: "charneykaye", type: "User" },
        body: "Vibrator's own comment (marker stripped by a quote)",
        created_at: "2024-03-01T10:00:00Z",
        html_url: "https://github.com/o/r/pull/50#issuecomment-1",
      },
      {
        id: 7002,
        user: { login: "charneykaye", type: "User" },
        body: "Genuine human feedback",
        created_at: "2024-03-02T10:00:00Z",
        html_url: "https://github.com/o/r/pull/50#issuecomment-2",
      },
    ],
  });

  const client = new GitHubClient({ owner: "outrightmental", repo: "testrepo", token: "token" });
  const comments = await client.listPullRequestComments(50, {
    excludeCommentIds: new Set([7001]),
  });

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.id, 7002);
  assert.equal(comments[0]?.body, "Genuine human feedback");
});

test("listPullRequestComments excludes comments that already carry a 👀 reaction", async (t) => {
  // Vibrator reacts 👀 to every comment it reads; on the next cycle that
  // comment must not be fed back into the review again.
  mockPrCommentEndpoints(t, 60, {
    issueComments: [
      {
        id: 8001,
        user: { login: "alice", type: "User" },
        body: "Already addressed last cycle",
        created_at: "2024-03-01T10:00:00Z",
        html_url: "https://github.com/o/r/pull/60#issuecomment-1",
        reactions: { eyes: 1 },
      },
      {
        id: 8002,
        user: { login: "alice", type: "User" },
        body: "Fresh feedback",
        created_at: "2024-03-02T10:00:00Z",
        html_url: "https://github.com/o/r/pull/60#issuecomment-2",
        reactions: { eyes: 0 },
      },
    ],
    reviewThreadComments: [
      {
        id: 8003,
        user: { login: "alice", type: "User" },
        body: "Inline note already seen",
        created_at: "2024-03-03T10:00:00Z",
        html_url: "https://github.com/o/r/pull/60#discussion_r1",
        reactions: { eyes: 2 },
      },
    ],
  });

  const client = new GitHubClient({ owner: "outrightmental", repo: "testrepo", token: "token" });
  const comments = await client.listPullRequestComments(60);

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.id, 8002);
  assert.equal(comments[0]?.body, "Fresh feedback");
});

test("addEyesReaction posts to the correct endpoint per comment kind", async (t) => {
  const reactionCalls: string[] = [];
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(_url);
      if (url.includes("/reactions")) {
        reactionCalls.push(`${url} ${String(init?.body ?? "")}`);
        return new Response(JSON.stringify({ id: 1 }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    },
  );
  t.after(() => {
    fetchMock.mock.restore();
  });

  const client = new GitHubClient({ owner: "outrightmental", repo: "testrepo", token: "token" });
  const base = { author: "alice", body: "x", createdAt: "2024-03-01T10:00:00Z", url: "u" } as const;

  await client.addEyesReaction({ ...base, id: 11, kind: "conversation" });
  await client.addEyesReaction({ ...base, id: 22, kind: "review-thread" });
  // PR reviews have no reactions endpoint — this must be a silent no-op.
  await client.addEyesReaction({ ...base, id: 33, kind: "review" });

  assert.equal(reactionCalls.length, 2);
  assert.ok(reactionCalls[0]?.includes("/issues/comments/11/reactions"), "conversation endpoint");
  assert.ok(reactionCalls[1]?.includes("/pulls/comments/22/reactions"), "review-thread endpoint");
  assert.ok(reactionCalls.every((c) => c.includes('"eyes"')), "sends the eyes reaction");
});

// ─── loadSnapshot project-mode: hasNewCommentsSinceLastRead detection ─────────

function makePr(overrides: Partial<{ updatedAt: string; draft: boolean }> = {}) {
  return {
    number: 10,
    title: "PR 10",
    body: "",
    headSha: "sha",
    headRefName: "branch",
    baseRefName: "main",
    state: "open" as const,
    draft: overrides.draft ?? false,
    hasMergeConflicts: false,
    hasCleanReviewOnHead: false,
    unresolvedReviewCommentCount: 0,
    checksStatus: "success" as const,
    headCommitPushedAt: undefined,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-02T00:00:00.000Z",
    linkedIssueNumbers: [1],
    closingIssueNumbers: [1],
  };
}

test("loadSnapshot (project mode) sets hasNewCommentsSinceLastRead when a human comment is newer than lastReadAt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vibrator-snapshot-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new FileSessionStore(join(dir, "sessions.json"));
  await store.createSession({ issueNumber: 1, pullRequestNumber: 10, phase: "request-review", status: "completed" });
  await store.setLastReadCommentAt(10, "2024-01-01T12:00:00.000Z");

  const client = new GitHubClient({ owner: "owner", repo: "repo", token: "fake" });
  t.mock.method(client, "listOpenIssues", async () => []);
  t.mock.method(client, "listOpenPullRequests", async () => [makePr()]);
  t.mock.method(client, "fetchProjectIssueStatuses", async () => new Map());
  // Comment at 15:00 is newer than lastReadAt (12:00).
  t.mock.method(client, "listPullRequestComments", async () => [
    { author: "alice", body: "Please fix X", createdAt: "2024-01-01T15:00:00.000Z" },
  ]);

  const snapshot = await loadSnapshot(client, store, { projectNumber: 1 });

  const pr = snapshot.pullRequests.find((p) => p.number === 10);
  assert.ok(pr !== undefined, "PR #10 should be in snapshot");
  assert.equal(pr.hasNewCommentsSinceLastRead, true);
});

test("loadSnapshot (project mode) does not set hasNewCommentsSinceLastRead when all comments predate lastReadAt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vibrator-snapshot-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new FileSessionStore(join(dir, "sessions.json"));
  await store.createSession({ issueNumber: 1, pullRequestNumber: 10, phase: "request-review", status: "completed" });
  await store.setLastReadCommentAt(10, "2024-01-01T12:00:00.000Z");

  const client = new GitHubClient({ owner: "owner", repo: "repo", token: "fake" });
  t.mock.method(client, "listOpenIssues", async () => []);
  t.mock.method(client, "listOpenPullRequests", async () => [makePr()]);
  t.mock.method(client, "fetchProjectIssueStatuses", async () => new Map());
  // Comment at 10:00 predates lastReadAt (12:00).
  t.mock.method(client, "listPullRequestComments", async () => [
    { author: "alice", body: "Old feedback", createdAt: "2024-01-01T10:00:00.000Z" },
  ]);

  const snapshot = await loadSnapshot(client, store, { projectNumber: 1 });

  const pr = snapshot.pullRequests.find((p) => p.number === 10);
  assert.ok(pr !== undefined, "PR #10 should be in snapshot");
  assert.equal(pr.hasNewCommentsSinceLastRead, undefined);
});

test("loadSnapshot (project mode) skips comment fetch when pr.updatedAt is not newer than lastReadAt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vibrator-snapshot-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new FileSessionStore(join(dir, "sessions.json"));
  await store.createSession({ issueNumber: 1, pullRequestNumber: 10, phase: "request-review", status: "completed" });
  // lastReadAt is 12:00; PR updatedAt is also 12:00 — no need to fetch.
  await store.setLastReadCommentAt(10, "2024-01-01T12:00:00.000Z");

  const client = new GitHubClient({ owner: "owner", repo: "repo", token: "fake" });
  t.mock.method(client, "listOpenIssues", async () => []);
  // PR updatedAt equals lastReadAt — the optimization should skip the comment fetch.
  t.mock.method(client, "listOpenPullRequests", async () => [makePr({ updatedAt: "2024-01-01T12:00:00.000Z" })]);
  t.mock.method(client, "fetchProjectIssueStatuses", async () => new Map());
  let commentsFetched = false;
  t.mock.method(client, "listPullRequestComments", async () => {
    commentsFetched = true;
    return [];
  });

  const snapshot = await loadSnapshot(client, store, { projectNumber: 1 });

  assert.equal(commentsFetched, false, "comments should not be fetched when updatedAt <= lastReadAt");
  const pr = snapshot.pullRequests.find((p) => p.number === 10);
  assert.equal(pr?.hasNewCommentsSinceLastRead, undefined);
});
