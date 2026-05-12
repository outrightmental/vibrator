import test from "node:test";
import assert from "node:assert/strict";

import { GitHubClient, isCleanCopilotReview } from "../src/github.js";

function countBraceBalance(value: string): number {
  let balance = 0;

  for (const character of value) {
    if (character === "{") {
      balance += 1;
    } else if (character === "}") {
      balance -= 1;
    }
  }

  return balance;
}

test("countUnresolvedPullRequestReviewThreads sends a balanced GraphQL query", async () => {
  const originalFetch = globalThis.fetch;
  const graphqlRequests: Array<{ query: string; variables: Record<string, unknown> }> = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    graphqlRequests.push(body);

    return new Response(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = new GitHubClient({
      owner: "outrightmental",
      repo: "vibrator",
      token: "test-token",
      apiBaseUrl: "https://example.test",
    });

    const unresolvedCount = await client.countUnresolvedPullRequestReviewThreads(12);

    assert.equal(unresolvedCount, 0);
    assert.equal(graphqlRequests.length, 1);
    const graphqlRequest = graphqlRequests[0];
    assert.ok(graphqlRequest);
    assert.match(graphqlRequest.query, /query ResolveReviewThreads/);
    assert.equal(countBraceBalance(graphqlRequest.query), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listOpenPullRequests merges GitHub closingIssuesReferences with body-keyword links", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();

    if (url.endsWith("/graphql")) {
      const body = JSON.parse(String(init?.body)) as { query: string };
      // We only expect the open-pull-request graphql data query here.
      assert.match(body.query, /query OpenPullRequestGraphQLData/);
      assert.equal(countBraceBalance(body.query), 0);
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: 101,
                    mergeable: "MERGEABLE",
                    closingIssuesReferences: { nodes: [{ number: 7 }] },
                  },
                  {
                    number: 102,
                    mergeable: "CONFLICTING",
                    closingIssuesReferences: { nodes: [] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/pulls")) {
      return new Response(
        JSON.stringify([
          {
            number: 101,
            title: "Draft PR linked only via sidebar",
            body: "No keyword reference here.",
            head: { sha: "sha-101", ref: "branch-101" },
            state: "open",
            draft: true,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
          {
            number: 102,
            title: "Body-only link",
            body: "Fixes #9",
            head: { sha: "sha-102", ref: "branch-102" },
            state: "open",
            draft: false,
            created_at: "2024-01-02T00:00:00.000Z",
            updated_at: "2024-01-02T00:00:00.000Z",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  try {
    const client = new GitHubClient({
      owner: "outrightmental",
      repo: "vibrator",
      token: "test-token",
      apiBaseUrl: "https://example.test",
    });

    const pullRequests = await client.listOpenPullRequests();

    const pr101 = pullRequests.find((pr) => pr.number === 101);
    const pr102 = pullRequests.find((pr) => pr.number === 102);
    assert.ok(pr101);
    assert.ok(pr102);
    // PR #101: linked only via GitHub sidebar — body has no keyword.
    assert.deepEqual(pr101.linkedIssueNumbers, [7]);
    assert.deepEqual(pr101.closingIssueNumbers, [7]);
    assert.equal(pr101.hasMergeConflicts, false);
    // PR #102: linked only via body keyword "Fixes #9"; has merge conflicts.
    assert.deepEqual(pr102.linkedIssueNumbers, [9]);
    assert.deepEqual(pr102.closingIssueNumbers, [9]);
    assert.equal(pr102.hasMergeConflicts, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isCleanCopilotReview accepts both 'no comments' and 'no new comments' wordings", () => {
  const base = {
    authorLogin: "copilot-pull-request-reviewer",
    state: "COMMENTED",
    reviewCommentCount: 0,
  };

  assert.equal(
    isCleanCopilotReview({
      ...base,
      body: "Copilot reviewed 3 files in this pull request and generated no comments.",
    }),
    true,
  );

  assert.equal(
    isCleanCopilotReview({
      ...base,
      body: "Copilot reviewed 3 out of 3 changed files in this pull request and generated no new comments.",
    }),
    true,
  );

  assert.equal(
    isCleanCopilotReview({
      ...base,
      body: "Copilot wasn't able to review any files in this pull request.",
    }),
    false,
  );
});
