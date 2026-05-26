import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRateLimitResponse,
  isRateLimitGraphQLError,
  parseRateLimitSnapshot,
  parseRetryAfter,
} from "../src/github-rate-limit.js";

test("parseRetryAfter parses delta seconds", () => {
  assert.equal(parseRetryAfter("60", 1_000), 60_000);
});

test("parseRetryAfter parses HTTP-date", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const raw = "Thu, 01 Jan 2026 00:01:30 GMT";
  assert.equal(parseRetryAfter(raw, now), 90_000);
});

test("parseRateLimitSnapshot reads GitHub rate-limit headers", () => {
  const headers = new Headers({
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": "1700000000",
    "x-ratelimit-resource": "core",
    "retry-after": "2",
  });

  const snapshot = parseRateLimitSnapshot(headers, "rest", 123);
  assert.equal(snapshot.limit, 5000);
  assert.equal(snapshot.remaining, 4999);
  assert.equal(snapshot.used, 1);
  assert.equal(snapshot.resetAtMs, 1_700_000_000_000);
  assert.equal(snapshot.retryAfterMs, 2_000);
  assert.equal(snapshot.resource, "core");
});

test("classifyRateLimitResponse classifies primary limits", () => {
  const hold = classifyRateLimitResponse({
    api: "rest",
    statusCode: 403,
    snapshot: {
      observedAtMs: 10,
      api: "rest",
      remaining: 0,
      resetAtMs: 20_000,
      resource: "core",
    },
    attempt: 1,
    nowMs: 10,
    resetSkewMs: 5_000,
    secondaryFallbackWaitMs: 60_000,
  });
  assert.ok(hold !== undefined);
  assert.equal(hold?.kind, "primary");
  assert.equal(hold?.blockedUntilMs, 25_000);
});

test("classifyRateLimitResponse classifies secondary limits with Retry-After", () => {
  const hold = classifyRateLimitResponse({
    api: "rest",
    statusCode: 429,
    snapshot: {
      observedAtMs: 1000,
      api: "rest",
      retryAfterMs: 90_000,
    },
    attempt: 1,
    nowMs: 1000,
    resetSkewMs: 5_000,
    secondaryFallbackWaitMs: 60_000,
  });
  assert.ok(hold !== undefined);
  assert.equal(hold?.kind, "secondary");
  assert.equal(hold?.waitMs, 95_000);
});

test("isRateLimitGraphQLError detects GraphQL rate-limit errors", () => {
  const payload = { errors: [{ message: "You have exceeded a secondary rate limit" }] };
  assert.equal(isRateLimitGraphQLError(payload), true);
  assert.equal(isRateLimitGraphQLError({ errors: [{ message: "validation failed" }] }), false);
});
