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

test("listPullRequestComments filters out the authenticated bot's own comments", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(_url);

      // GraphQL viewer query for authenticated login
      if (url.includes("/graphql") && String(init?.body ?? "").includes("viewer")) {
        return new Response(
          JSON.stringify({ data: { viewer: { login: "vibrator-bot" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // REST comments endpoint
      if (url.includes("/issues/42/comments")) {
        return new Response(
          JSON.stringify([
            {
              user: { login: "vibrator-bot" },
              body: "Reviewed code, no issues found.",
              created_at: "2024-03-01T10:00:00Z",
            },
            {
              user: { login: "alice" },
              body: "Please add more tests",
              created_at: "2024-03-02T09:00:00Z",
            },
            {
              user: { login: "bob" },
              body: "Consider edge cases",
              created_at: "2024-03-03T08:00:00Z",
            },
          ]),
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

  const comments = await client.listPullRequestComments(42);

  // The bot's own comment is filtered out
  assert.equal(comments.length, 2);
  assert.equal(comments[0]?.author, "alice");
  assert.equal(comments[0]?.body, "Please add more tests");
  assert.equal(comments[1]?.author, "bob");
  assert.equal(comments[1]?.body, "Consider edge cases");
});

test("listPullRequestComments returns empty array when all comments are from the bot", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(_url);

      if (url.includes("/graphql") && String(init?.body ?? "").includes("viewer")) {
        return new Response(
          JSON.stringify({ data: { viewer: { login: "vibrator-bot" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/issues/10/comments")) {
        return new Response(
          JSON.stringify([
            {
              user: { login: "vibrator-bot" },
              body: "Addressed failing CI checks.",
              created_at: "2024-03-01T10:00:00Z",
            },
          ]),
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

  const comments = await client.listPullRequestComments(10);
  assert.equal(comments.length, 0);
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
