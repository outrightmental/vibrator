import test from "node:test";
import assert from "node:assert/strict";

import { GitHubClient } from "../src/github.js";

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
