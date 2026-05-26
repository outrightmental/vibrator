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
