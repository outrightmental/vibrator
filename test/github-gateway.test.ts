import test from "node:test";
import assert from "node:assert/strict";

import { GitHubApiGateway } from "../src/github-gateway.js";
import type { DashboardEvent } from "../src/event-emitter.js";
import { globalEventEmitter } from "../src/event-emitter.js";

function withEventCapture<T>(run: (events: DashboardEvent[]) => Promise<T>): Promise<T> {
  const events: DashboardEvent[] = [];
  const unsubscribe = globalEventEmitter.subscribe((event) => {
    events.push(event);
  });
  return run(events).finally(() => unsubscribe());
}

test("GitHubApiGateway serializes concurrent requests through a single queue", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  const gateway = new GitHubApiGateway({
    token: "token",
    fetchImpl: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await Promise.all([
    gateway.request("/repos/o/r/issues"),
    gateway.request("/repos/o/r/pulls"),
    gateway.request("/repos/o/r/labels"),
  ]);

  assert.equal(maxInFlight, 1);
});

test("GitHubApiGateway applies rate-limit hold, retries, and emits hold/cleared events", async () => {
  let nowMs = 1_000;
  const sleeps: number[] = [];
  let callCount = 0;

  await withEventCapture(async (events) => {
    const gateway = new GitHubApiGateway({
      token: "token",
      clock: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ message: "API rate limit exceeded" }),
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor((nowMs + 2_000) / 1000)),
                "x-ratelimit-resource": "core",
                "Content-Type": "application/json",
              },
            },
          );
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const payload = await gateway.request<{ ok: boolean }>("/repos/o/r/issues");
    assert.equal(payload.ok, true);
    assert.equal(callCount, 2);
    assert.ok(sleeps.some((ms) => ms >= 6_000), "should sleep through reset+skew window");

    const holdEvent = events.find((event) => event.type === "github-rate-limit");
    const clearedEvent = events.find((event) => event.type === "github-rate-limit-cleared");
    assert.ok(holdEvent, "expected github-rate-limit event");
    assert.ok(clearedEvent, "expected github-rate-limit-cleared event");
  });
});

test("GitHubApiGateway retries GraphQL HTTP 200 rate-limit errors", async () => {
  let callCount = 0;
  let nowMs = 1_000;

  const gateway = new GitHubApiGateway({
    token: "token",
    clock: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ errors: [{ message: "You have exceeded a secondary rate limit" }] }),
          {
            status: 200,
            headers: {
              "retry-after": "1",
              "x-ratelimit-remaining": "1",
              "Content-Type": "application/json",
            },
          },
        );
      }
      return new Response(JSON.stringify({ data: { viewer: { login: "bot" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await gateway.graphql<{ viewer: { login: string } }>(
    "query { viewer { login } }",
    {},
  );
  assert.equal(result.viewer.login, "bot");
  assert.equal(callCount, 2);
});

test("GitHubApiGateway sends If-None-Match and serves cached body on 304 (saving rate limit)", async () => {
  const sentIfNoneMatch: Array<string | null> = [];
  let callCount = 0;

  const gateway = new GitHubApiGateway({
    token: "token",
    fetchImpl: async (_url, init) => {
      callCount += 1;
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      sentIfNoneMatch.push(headers.get("if-none-match"));
      if (callCount === 1) {
        return new Response(JSON.stringify([{ number: 1 }]), {
          status: 200,
          headers: { ETag: '"abc123"', "Content-Type": "application/json" },
        });
      }
      // Resource unchanged — GitHub answers 304 with no body.
      return new Response(null, {
        status: 304,
        headers: { ETag: '"abc123"' },
      });
    },
  });

  const first = await gateway.request<Array<{ number: number }>>("/repos/o/r/issues?state=open");
  const second = await gateway.request<Array<{ number: number }>>("/repos/o/r/issues?state=open");

  assert.deepEqual(first, [{ number: 1 }]);
  assert.deepEqual(second, [{ number: 1 }], "304 should replay the cached body");
  assert.equal(callCount, 2);
  assert.equal(sentIfNoneMatch[0], null, "first request has no ETag to send");
  assert.equal(sentIfNoneMatch[1], '"abc123"', "second request sends If-None-Match");
});

test("GitHubApiGateway replays cached Link header so pagination survives a 304", async () => {
  let callCount = 0;
  const gateway = new GitHubApiGateway({
    token: "token",
    fetchImpl: async (url) => {
      callCount += 1;
      const target = typeof url === "string" ? url : url.toString();
      // Page 2 always returns a fresh single item; page 1 is cached then 304s.
      if (target.includes("page=2")) {
        return new Response(JSON.stringify([{ number: 2 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (callCount === 1) {
        return new Response(JSON.stringify([{ number: 1 }]), {
          status: 200,
          headers: {
            ETag: '"page1"',
            "Content-Type": "application/json",
            Link: '<https://api.github.com/repos/o/r/issues?per_page=100&page=2>; rel="next"',
          },
        });
      }
      return new Response(null, { status: 304, headers: { ETag: '"page1"' } });
    },
  });

  const firstRun = await gateway.getAllPages<{ number: number }>("/repos/o/r/issues");
  const secondRun = await gateway.getAllPages<{ number: number }>("/repos/o/r/issues");

  assert.deepEqual(firstRun, [{ number: 1 }, { number: 2 }]);
  assert.deepEqual(
    secondRun,
    [{ number: 1 }, { number: 2 }],
    "a 304 on page 1 must still follow the cached Link to page 2",
  );
});

test("GitHubApiGateway skips conditional requests when disabled", async () => {
  const sentIfNoneMatch: Array<string | null> = [];
  const gateway = new GitHubApiGateway({
    token: "token",
    conditionalRequests: false,
    fetchImpl: async (_url, init) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      sentIfNoneMatch.push(headers.get("if-none-match"));
      return new Response(JSON.stringify([{ number: 1 }]), {
        status: 200,
        headers: { ETag: '"abc123"', "Content-Type": "application/json" },
      });
    },
  });

  await gateway.request("/repos/o/r/issues?state=open");
  await gateway.request("/repos/o/r/issues?state=open");

  assert.deepEqual(sentIfNoneMatch, [null, null], "no If-None-Match when caching disabled");
});

test("GitHubApiGateway enforces spacing between mutative requests", async () => {
  let nowMs = 1_000;
  const sleeps: number[] = [];

  const gateway = new GitHubApiGateway({
    token: "token",
    clock: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    fetchImpl: async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    mutativeSpacingMs: 1100,
  });

  await gateway.request("/repos/o/r/issues/1/comments", {
    method: "POST",
    body: JSON.stringify({ body: "hello" }),
  });
  await gateway.request("/repos/o/r/issues/1/comments", {
    method: "POST",
    body: JSON.stringify({ body: "again" }),
  });

  assert.ok(sleeps.some((ms) => ms >= 1100), "second mutative request should wait for spacing window");
});
