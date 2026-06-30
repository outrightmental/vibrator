import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitHubClient,
  isReviewBot,
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

test("squashMergePullRequest marks draft PR ready and calls squash merge API", async (t) => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/pulls/160") && init?.method === undefined) {
        return new Response(JSON.stringify({ node_id: "PR_node", draft: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/graphql")) {
        return new Response(
          JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (String(url).endsWith("/pulls/160/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({ merged: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    },
  );
  t.after(() => fetchMock.mock.restore());

  const client = new GitHubClient({ owner: "outrightmental", repo: "readtheroom", token: "token" });
  await client.squashMergePullRequest(160, "Subject", "Body");

  assert.equal(requests.length, 3);
  assert.match(requests[1]!.init?.body as string, /markPullRequestReadyForReview/);
  assert.deepEqual(JSON.parse(requests[2]!.init?.body as string), {
    commit_title: "Subject",
    commit_message: "Body",
    merge_method: "squash",
  });
});

test("squashMergePullRequest skips ready mutation for non-draft PR", async (t) => {
  const requests: string[] = [];
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(String(url));
      if (String(url).endsWith("/pulls/160") && init?.method === undefined) {
        return new Response(JSON.stringify({ node_id: "PR_node", draft: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/pulls/160/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({ merged: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    },
  );
  t.after(() => fetchMock.mock.restore());

  const client = new GitHubClient({ owner: "outrightmental", repo: "readtheroom", token: "token" });
  await client.squashMergePullRequest(160, "Subject", "Body");

  assert.deepEqual(requests, [
    "https://api.github.com/repos/outrightmental/readtheroom/pulls/160",
    "https://api.github.com/repos/outrightmental/readtheroom/pulls/160/merge",
  ]);
});

test("squashMergePullRequest surfaces protected-branch API failures clearly", async (t) => {
  const stderr = captureStderr(t);
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).endsWith("/pulls/160") && init?.method === undefined) {
        return new Response(JSON.stringify({ node_id: "PR_node", draft: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/pulls/160/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({ message: "base branch policy prohibits the merge" }), {
          status: 405,
          statusText: "Method Not Allowed",
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    },
  );
  t.after(() => fetchMock.mock.restore());

  const client = new GitHubClient({ owner: "outrightmental", repo: "readtheroom", token: "token" });
  let error: unknown;
  try {
    await client.squashMergePullRequest(160, "Subject", "Body");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /branch protection may be blocking the merge/);
  assert.equal((error as Error & { statusCode?: number }).statusCode, 405);
  assert.equal(
    ((error as Error & { cause?: { statusCode?: number } }).cause as { statusCode?: number })
      ?.statusCode,
    405,
  );
  assert.match(stderr.output(), /base branch policy prohibits the merge/);
});

test("runtime source no longer shells out to gh CLI operations", () => {
  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        collect(path);
      } else if (path.endsWith(".ts")) {
        files.push(path);
      }
    }
  };
  collect(join(process.cwd(), "src"));

  const forbidden = [
    ["gh", "auth", "token"].join(" "),
    ["gh", "pr"].join(" "),
    ["gh", "repo", "clone"].join(" "),
    "runCommand(" + JSON.stringify("gh"),
    "runShellCommand(" + JSON.stringify("gh"),
    "spawn(" + JSON.stringify("gh"),
  ];
  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    for (const needle of forbidden) {
      assert.equal(
        contents.includes(needle),
        false,
        `${file} should not contain ${needle}`,
      );
    }
  }
});

test("claude-agent routes PR checkout metadata through the shared GitHub gateway", () => {
  const source = readFileSync(join(process.cwd(), "src", "claude-agent.ts"), "utf8");
  assert.equal(
    /fetchPullRequestForCheckout[\s\S]*this\.githubGateway\.request/.test(source),
    true,
    "fetchPullRequestForCheckout should call githubGateway.request",
  );
  assert.equal(
    /fetchPullRequestForCheckout[\s\S]*await fetch\(/.test(source),
    false,
    "fetchPullRequestForCheckout should not call fetch directly",
  );
});

test("listOpenIssues attaches GitHub-native blocked_by dependencies to issues", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = String(_url);

      // REST issue list: two open issues, #336 and #327.
      if (url.includes("/issues?") && !url.includes("/graphql")) {
        return new Response(
          JSON.stringify([
            {
              number: 336,
              title: "Blocked issue",
              body: "no blocker mentions in body",
              state: "open",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
            },
            {
              number: 327,
              title: "Blocker (also blocked by another)",
              body: "no blocker mentions in body",
              state: "open",
              created_at: "2024-01-02T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // GraphQL parent-numbers query: no sub-issues in this repo.
      if (url.includes("/graphql")) {
        return new Response(
          JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Issue-dependencies REST endpoint.
      if (url.endsWith("/issues/336/dependencies/blocked_by")) {
        return new Response(
          JSON.stringify([
            { number: 327, state: "open" },
            // A closed blocker that must be filtered out.
            { number: 325, state: "closed" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/issues/327/dependencies/blocked_by")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch call to ${url}`);
    },
  );

  t.after(() => {
    fetchMock.mock.restore();
  });

  const client = new GitHubClient({
    owner: "outrightmental",
    repo: "readtheroom",
    token: "token",
  });

  const issues = await client.listOpenIssues();
  const blocked = issues.find((i) => i.number === 336);
  const blocker = issues.find((i) => i.number === 327);

  assert.deepEqual(blocked?.blockedByIssueNumbers, [327]);
  assert.equal(
    blocker?.blockedByIssueNumbers,
    undefined,
    "Issues with an empty blocked_by list must not carry the field at all.",
  );
});

test("listOpenIssues falls back gracefully when Issue Dependencies endpoint is unavailable", async (t) => {
  const warnOutput: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnOutput.push(args.map(String).join(" "));
  });

  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request): Promise<Response> => {
      const url = String(_url);

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
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/graphql")) {
        return new Response(
          JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/dependencies/blocked_by")) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
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
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.blockedByIssueNumbers, undefined);
  assert.equal(
    issues[0]?.blockersUnknown,
    undefined,
    "A 404 means the feature is off, not that blockers are unknown — must NOT fail closed.",
  );
  assert.ok(
    warnOutput.some((line) => line.includes("Issue Dependencies feature")),
    "Expected a warning explaining the dependency-endpoint degradation",
  );
});

test("listOpenIssues marks blockersUnknown when a dependency lookup fails transiently", async (t) => {
  // Regression: a transient (non-404) failure of the per-issue dependency
  // lookup used to be swallowed, leaving the issue with no blockers — so the
  // planner started it even though its real blockers were still open. The
  // failed issue must instead be flagged blockersUnknown so the planner fails
  // closed. A second issue with a clean (empty) lookup must be unaffected.
  const warnOutput: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnOutput.push(args.map(String).join(" "));
  });

  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request): Promise<Response> => {
      const url = String(_url);

      if (url.includes("/issues?") && !url.includes("/graphql")) {
        return new Response(
          JSON.stringify([
            {
              number: 5,
              title: "Issue five (lookup will fail)",
              body: "no blocker mentions in body",
              state: "open",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
            },
            {
              number: 6,
              title: "Issue six (clean lookup)",
              body: "no blocker mentions in body",
              state: "open",
              created_at: "2024-01-02T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/graphql")) {
        return new Response(
          JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // #5's dependency lookup fails with a plain 403 (not a rate-limit
      // signal: no x-ratelimit headers, non-secondary body) — thrown
      // immediately by the gateway with statusCode 403.
      if (url.endsWith("/issues/5/dependencies/blocked_by")) {
        return new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      // #6 has no dependencies.
      if (url.endsWith("/issues/6/dependencies/blocked_by")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
  const five = issues.find((i) => i.number === 5);
  const six = issues.find((i) => i.number === 6);

  assert.equal(
    five?.blockersUnknown,
    true,
    "Issue whose dependency lookup failed must be flagged blockersUnknown (fail closed).",
  );
  assert.equal(
    six?.blockersUnknown,
    undefined,
    "Issue with a clean lookup must NOT be flagged unknown.",
  );
  assert.equal(six?.blockedByIssueNumbers, undefined);
  assert.ok(
    warnOutput.some((line) => line.includes("blocker status as unknown")),
    "Expected a warning explaining the issue was treated as unknown.",
  );
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

      // Issue-dependencies endpoint: no dependencies in this repo.
      if (url.includes("/dependencies/blocked_by")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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

test("isReviewBot recognizes Copilot and CodeRabbit logins but not noise bots", () => {
  assert.equal(isReviewBot("Copilot"), true);
  assert.equal(isReviewBot("copilot-pull-request-reviewer[bot]"), true);
  assert.equal(isReviewBot("coderabbitai[bot]"), true);
  assert.equal(isReviewBot("github-actions[bot]"), false);
  assert.equal(isReviewBot("dependabot[bot]"), false);
  assert.equal(isReviewBot("charneykaye"), false);
  assert.equal(isReviewBot(null), false);
  assert.equal(isReviewBot(undefined), false);
});

test("listPullRequestComments keeps Copilot review-bot feedback but drops noise bots", async (t) => {
  // GitHub Copilot posts its review summary under `copilot-pull-request-reviewer[bot]`
  // and its inline comments under `Copilot` — both `Bot`-type accounts. That
  // feedback must reach Vibrator, while CI noise bots stay excluded.
  mockPrCommentEndpoints(t, 74, {
    issueComments: [
      {
        user: { login: "github-actions[bot]", type: "Bot" },
        body: "Visit the preview URL for this PR",
        created_at: "2026-05-29T01:00:00Z",
        html_url: "https://github.com/o/r/pull/74#issuecomment-1",
      },
    ],
    reviews: [
      {
        user: { login: "copilot-pull-request-reviewer[bot]", type: "Bot" },
        body: "## Pull request overview\n\nReplaces the legacy UI.",
        submitted_at: "2026-05-29T01:58:25Z",
        html_url: "https://github.com/o/r/pull/74#pullrequestreview-1",
      },
    ],
    reviewThreadComments: [
      {
        user: { login: "Copilot", type: "Bot" },
        body: "This variable name is unclear.",
        created_at: "2026-05-29T01:58:30Z",
        html_url: "https://github.com/o/r/pull/74#discussion_r1",
      },
    ],
  });

  const client = new GitHubClient({ owner: "outrightmental", repo: "testrepo", token: "token" });
  const comments = await client.listPullRequestComments(74);

  // The Copilot review summary and inline comment survive; the github-actions
  // preview comment is dropped.
  assert.deepEqual(
    comments.map((c) => c.kind),
    ["review", "review-thread"],
  );
  assert.equal(comments[0]?.author, "copilot-pull-request-reviewer[bot]");
  assert.equal(comments[1]?.author, "Copilot");
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

test("loadSnapshot does not throw when listing open issues fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vibrator-snapshot-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new FileSessionStore(join(dir, "sessions.json"));
  const client = new GitHubClient({ owner: "owner", repo: "repo", token: "fake" });
  t.mock.method(client, "listOpenIssues", async () => {
    throw new Error("GitHub request failed (403 Forbidden) for /issues");
  });
  t.mock.method(client, "listOpenPullRequests", async () => [makePr()]);

  const snapshot = await loadSnapshot(client, store);

  assert.deepEqual(snapshot.issues, []);
  assert.equal(snapshot.pullRequests.length, 1);
});

test("loadSnapshot does not throw when listing open pull requests fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vibrator-snapshot-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new FileSessionStore(join(dir, "sessions.json"));
  const client = new GitHubClient({ owner: "owner", repo: "repo", token: "fake" });
  t.mock.method(client, "listOpenIssues", async () => []);
  t.mock.method(client, "listOpenPullRequests", async () => {
    throw new Error("GitHub request failed (403 Forbidden) for /pulls?state=open");
  });

  const snapshot = await loadSnapshot(client, store);

  assert.deepEqual(snapshot.pullRequests, []);
  assert.equal(snapshot.issues.length, 0);
});
