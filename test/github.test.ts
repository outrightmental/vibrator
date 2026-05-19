import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";

import {
  GitHubClient,
  isVibratorReview,
  VIBRATOR_REVIEW_MARKER,
} from "../src/github.js";

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
