import test from "node:test";
import assert from "node:assert/strict";

import { detectRateLimitMessage } from "../src/rate-limit.js";

const FIXED_NOW = new Date("2026-05-11T12:00:00.000Z");

test("detectRateLimitMessage parses the literal Copilot rate-limit message and returns the reset instant", () => {
  // Copy of the message from the bug report (issue/PR 98) — must continue
  // to match verbatim so the orchestrator pauses for the right duration.
  const body =
    "You've hit your rate limit. Please wait for your limit to reset in 28 minutes " +
    "or switch to auto model to continue. Learn More " +
    "(https://docs.github.com/copilot/concepts/rate-limits). If the problem persists, " +
    "please contact GitHub Support, including the request ID `CC25:938ED:1711F2A:18C66C5:6A0218A3`. " +
    "To retry, leave a comment on this pull request asking Copilot to try again.";

  const detection = detectRateLimitMessage(body, FIXED_NOW);

  assert.ok(detection, "expected a detection result");
  assert.equal(detection.durationWasParsed, true);
  assert.equal(
    detection.resetAt.toISOString(),
    new Date(FIXED_NOW.getTime() + 28 * 60_000).toISOString(),
  );
});

test("detectRateLimitMessage supports seconds, hours, and days units", () => {
  const cases: Array<[string, number]> = [
    ["You've hit your rate limit. Please wait for your limit to reset in 90 seconds.", 90 * 1_000],
    ["You've hit your rate limit. Please wait for your limit to reset in 2 hours.", 2 * 60 * 60_000],
    ["You've hit your rate limit. Please wait for your limit to reset in 1 day.", 24 * 60 * 60_000],
  ];

  for (const [body, expectedMs] of cases) {
    const detection = detectRateLimitMessage(body, FIXED_NOW);
    assert.ok(detection, `expected detection for "${body}"`);
    assert.equal(detection.durationWasParsed, true);
    assert.equal(
      detection.resetAt.toISOString(),
      new Date(FIXED_NOW.getTime() + expectedMs).toISOString(),
    );
  }
});

test("detectRateLimitMessage falls back to a default window when only the generic phrase matches", () => {
  // A future template might drop the "reset in N minutes" clause — we
  // still want to pause rather than spam the repo. Use the configured
  // fallback window.
  const detection = detectRateLimitMessage(
    "You've hit your rate limit. Please contact support.",
    FIXED_NOW,
    30 * 60_000,
  );
  assert.ok(detection);
  assert.equal(detection.durationWasParsed, false);
  assert.equal(
    detection.resetAt.toISOString(),
    new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString(),
  );
});

test("detectRateLimitMessage returns null for unrelated messages", () => {
  assert.equal(detectRateLimitMessage("Copilot finished work.", FIXED_NOW), null);
  assert.equal(detectRateLimitMessage("", FIXED_NOW), null);
  assert.equal(detectRateLimitMessage(null, FIXED_NOW), null);
  assert.equal(detectRateLimitMessage(undefined, FIXED_NOW), null);
});
