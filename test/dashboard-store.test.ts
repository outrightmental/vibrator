import test from "node:test";
import assert from "node:assert/strict";
import { dashboardReducer, initialState } from "../src/dashboard/store/dashboard-store.js";
import type { DashboardState } from "../src/dashboard/store/dashboard-store.js";

interface WireEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function makeEvent(type: string, data: Record<string, unknown> = {}): WireEvent {
  return { type, timestamp: new Date().toISOString(), data };
}

// ── iteration-start ───────────────────────────────────────────────────────────

test("reducer: iteration-start initialises cylinder at engineIndex", () => {
  const s0 = initialState();
  const s1 = dashboardReducer(s0, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 5, maxConcurrency: 3 }));
  assert.equal(s1.cylinders[0]?.iterationNumber, 5);
  assert.equal(s1.cylinders[0]?.status, "idle");
  assert.equal(s1.maxConcurrency, 3);
});

test("reducer: iteration-start clears stale issue/PR mappings", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 7, description: "d" }));
  assert.equal(s.cylinderByIssue.get(7), 0, "cylinder 0 should own issue 7");

  s = dashboardReducer(s, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 2, maxConcurrency: 3 }));
  assert.equal(s.cylinderByIssue.has(7), false, "issue mapping should be cleared on iteration-start");
});

test("reducer: iteration-start with new maxConcurrency re-initialises all cylinders", () => {
  let s = initialState();
  assert.equal(s.cylinders.length, 3);
  s = dashboardReducer(s, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 1, maxConcurrency: 2 }));
  assert.equal(s.cylinders.length, 2);
});

test("reducer: cylinder colors cycle through the palette via modulo (no gray fallback)", () => {
  // Initialise more cylinders than there are palette colors (6) to exercise the
  // modulo wrap — every cylinder must get a real neon color, never gray.
  let s = initialState();
  s = dashboardReducer(s, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 1, maxConcurrency: 8 }));
  assert.equal(s.cylinders.length, 8);

  for (const cyl of s.cylinders) {
    assert.notEqual(cyl.color, "#888888", "no cylinder should fall back to gray");
    assert.notEqual(cyl.colorRgb, "136,136,136", "no cylinder should fall back to gray rgb");
  }

  // Cylinder 7 (index 6) wraps back to the first palette entry, cylinder 8 to the second.
  assert.equal(s.cylinders[6]?.color, s.cylinders[0]?.color, "color should wrap via modulo");
  assert.equal(s.cylinders[7]?.color, s.cylinders[1]?.color, "color should wrap via modulo");
});

// ── action-start ──────────────────────────────────────────────────────────────

test("reducer: action-start sets cylinder to active", () => {
  const s0 = initialState();
  const s1 = dashboardReducer(s0, makeEvent("action-start", {
    actionIndex: 1,
    totalActions: 2,
    type: "start-implementation",
    issueNumber: 42,
    description: "implementing #42",
  }));
  assert.equal(s1.cylinders[0]?.status, "active");
  assert.equal(s1.cylinders[0]?.issueNumber, 42);
  assert.equal(s1.cylinders[0]?.actionType, "start-implementation");
  assert.equal(s1.cylinderByIssue.get(42), 0);
});

test("reducer: action-start preserves startedAt when provided", () => {
  const s0 = initialState();
  const startedAt = Date.now() - 60_000;
  const s1 = dashboardReducer(s0, makeEvent("action-start", {
    actionIndex: 1,
    totalActions: 1,
    type: "self-review",
    startedAt,
  }));
  assert.equal(s1.cylinders[0]?.actionStartedAt, startedAt);
});

// ── action-complete / action-error ────────────────────────────────────────────

test("reducer: action-complete sets cylinder to done", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", description: "d" }));
  s = dashboardReducer(s, makeEvent("action-complete", { actionIndex: 1, totalActions: 1 }));
  assert.equal(s.cylinders[0]?.status, "done");
  assert.deepEqual(s.cylinders[0]?.thinkingLines, []);
});

test("reducer: action-error sets cylinder to error", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", description: "d" }));
  s = dashboardReducer(s, makeEvent("action-error", { actionIndex: 1, totalActions: 1, error: "timeout" }));
  assert.equal(s.cylinders[0]?.status, "error");
});

// ── engine-idle ───────────────────────────────────────────────────────────────

test("reducer: engine-idle sets cylinder idle and preserves timing fields", () => {
  const nextCycleAtMs = Date.now() + 30_000;
  const rateLimitedUntilMs = Date.now() + 900_000;
  let s = initialState();
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, nextCycleAtMs, rateLimitedUntilMs }));
  assert.equal(s.cylinders[0]?.status, "idle");
  assert.equal(s.cylinders[0]?.nextCycleAtMs, nextCycleAtMs);
  assert.equal(s.cylinders[0]?.rateLimitedUntilMs, rateLimitedUntilMs);
});

test("reducer: engine-idle clears cylinder issue/PR mappings", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 5, description: "d" }));
  assert.ok(s.cylinderByIssue.has(5));
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, reason: "done" }));
  assert.equal(s.cylinderByIssue.has(5), false);
});

// ── engine-shutdown ───────────────────────────────────────────────────────────

test("reducer: engine-shutdown sets cylinder to shutdown", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("engine-shutdown", { engineIndex: 1 }));
  assert.equal(s.cylinders[1]?.status, "shutdown");
});

// ── shutdown-requested / app-shutdown ─────────────────────────────────────────

test("reducer: shutdown-requested sets shutdownRequested flag", () => {
  const s = dashboardReducer(initialState(), makeEvent("shutdown-requested", {}));
  assert.equal(s.shutdownRequested, true);
});

test("reducer: app-shutdown sets appShutdown flag", () => {
  const s = dashboardReducer(initialState(), makeEvent("app-shutdown", {}));
  assert.equal(s.appShutdown, true);
});

// ── snapshot-update ───────────────────────────────────────────────────────────

test("reducer: snapshot-update populates issueCards and prCards", () => {
  const s = dashboardReducer(initialState(), makeEvent("snapshot-update", {
    issueCount: 2,
    prCount: 1,
    sessionCount: 3,
    issues: [{ number: 1, title: "Bug", state: "open" }, { number: 2, title: "Feat", state: "open" }],
    pullRequests: [{ number: 10, title: "Fix", state: "open" }],
  }));
  assert.equal(s.issueCards.size, 2);
  assert.equal(s.prCards.size, 1);
  assert.equal(s.sessionCount, 3);
});

// ── lifecycle-update ──────────────────────────────────────────────────────────

test("reducer: lifecycle-update stores lastLifecyclePairs", () => {
  const pairs = [
    { issue: { number: 1, title: "A", state: "open" }, prPhase: "active" },
  ];
  const s = dashboardReducer(initialState(), makeEvent("lifecycle-update", { pairs }));
  assert.equal(s.lastLifecyclePairs.length, 1);
  assert.equal(s.lastLifecyclePairs[0]?.prPhase, "active");
});

// ── broadcast events ──────────────────────────────────────────────────────────

test("reducer: broadcast-commit adds to broadcastQueue", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-commit", {
    stateBefore: "old",
    changeHow: "merged",
    stateAfter: "new",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.category, "commit");
});

test("reducer: broadcast-pr-update adds to broadcastQueue with correct label", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-pr-update", {
    stateBefore: "draft",
    changeHow: "marked ready",
    stateAfter: "ready",
  }));
  assert.equal(s.broadcastQueue[0]?.label, "PR UPDATE");
});

test("reducer: workflow-approval adds to broadcastQueue with WORKFLOW label", () => {
  const s = dashboardReducer(initialState(), makeEvent("workflow-approval", {
    runName: "CI",
    runId: "abc123",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.label, "WORKFLOW");
});

// ── cylinder-cancel ───────────────────────────────────────────────────────────

test("reducer: cylinder-cancel sets idleStatusText to 'cancelling…' and clears nextCycleAtMs", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, nextCycleAtMs: Date.now() + 30_000 }));
  s = dashboardReducer(s, makeEvent("cylinder-cancel", { engineIndex: 0 }));
  assert.equal(s.cylinders[0]?.idleStatusText, "cancelling…");
  assert.equal(s.cylinders[0]?.nextCycleAtMs, null);
  assert.ok(s.eventStream.at(-1)?.text.includes("cancel"), "event stream should mention cancel");
  assert.equal(s.eventStream.at(-1)?.level, "warning");
});

// ── github-rate-limit / github-rate-limit-cleared ─────────────────────────────

test("reducer: github-rate-limit adds warning to eventStream", () => {
  const s = dashboardReducer(initialState(), makeEvent("github-rate-limit", {
    kind: "secondary",
    api: "rest",
    message: "secondary rate limited",
    waitMs: 60000,
  }));
  assert.equal(s.eventCount, 1);
  assert.ok(s.eventStream[0]?.text.includes("rate limit"), "should mention rate limit");
  assert.equal(s.eventStream[0]?.level, "warning");
});

test("reducer: github-rate-limit-cleared adds success message to eventStream", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("github-rate-limit", { message: "limited" }));
  s = dashboardReducer(s, makeEvent("github-rate-limit-cleared", {}));
  assert.equal(s.eventCount, 2);
  assert.ok(s.eventStream[1]?.text.includes("cleared"), "should mention cleared");
  assert.equal(s.eventStream[1]?.level, "success");
});

// ── claude-thinking ───────────────────────────────────────────────────────────

test("reducer: claude-thinking appends thinking lines up to 200", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", description: "d" }));
  s = dashboardReducer(s, makeEvent("claude-thinking", { engineIndex: 0, excerpt: "line1\nline2\nline3" }));
  assert.equal(s.cylinders[0]?.thinkingLines.length, 3);
  assert.equal(s.cylinders[0]?.thinkingLines[0], "line1");
});

// ── eventStream / eventCount ──────────────────────────────────────────────────

test("reducer: events increment eventCount", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("log-message", { message: "hello", level: "info" }));
  s = dashboardReducer(s, makeEvent("log-message", { message: "world", level: "info" }));
  assert.equal(s.eventCount, 2);
  assert.equal(s.eventStream.length, 2);
});

// ── phase-update ──────────────────────────────────────────────────────────────

test("reducer: phase-update adds to eventStream", () => {
  const s = dashboardReducer(initialState(), makeEvent("phase-update", { phase: "planning" }));
  assert.equal(s.eventCount, 1);
  assert.ok(s.eventStream[0]?.text.includes("planning"), "event text should include phase name");
});

// ── default handler (cycle-start, plan-update, iteration-complete) ────────────

test("reducer: unknown/default event type adds to eventStream", () => {
  const s = dashboardReducer(initialState(), makeEvent("cycle-start", {}));
  assert.equal(s.eventCount, 1);
  assert.ok(s.eventStream[0]?.text.includes("cycle-start"), "should include event type in text");
});

// ── broadcast-ci-status ───────────────────────────────────────────────────────

test("reducer: broadcast-ci-status adds to broadcastQueue with ci category", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-ci-status", {
    stateBefore: "failing",
    changeHow: "fixed tests",
    stateAfter: "passing",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.category, "ci");
  assert.equal(s.broadcastQueue[0]?.label, "CI STATUS");
});

// ── broadcast-review-comment ──────────────────────────────────────────────────

test("reducer: broadcast-review-comment adds to broadcastQueue", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-review-comment", {
    stateBefore: "pending review",
    changeHow: "reviewer approved",
    stateAfter: "approved",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.label, "REVIEW COMMENT");
});

// ── broadcast-issue-update ────────────────────────────────────────────────────

test("reducer: broadcast-issue-update adds to broadcastQueue with issue category", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-issue-update", {
    stateBefore: "open",
    changeHow: "closed by PR",
    stateAfter: "closed",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.category, "issue");
  assert.equal(s.broadcastQueue[0]?.label, "ISSUE UPDATE");
});

// ── broadcast-github-activity ─────────────────────────────────────────────────

test("reducer: broadcast-github-activity adds to broadcastQueue", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-github-activity", {
    stateBefore: "quiet",
    changeHow: "push happened",
    stateAfter: "active",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.label, "GITHUB ACTIVITY");
});

// ── full replay sequence ──────────────────────────────────────────────────────

test("reducer: applying a sequence of cached events produces consistent state", () => {
  const events: WireEvent[] = [
    makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 1, maxConcurrency: 2 }),
    makeEvent("action-start", { actionIndex: 1, totalActions: 2, type: "start-implementation", issueNumber: 10, description: "d" }),
    makeEvent("snapshot-update", { issueCount: 1, prCount: 0, sessionCount: 1, issues: [{ number: 10, title: "X", state: "open" }], pullRequests: [] }),
    makeEvent("lifecycle-update", { pairs: [{ issue: { number: 10, title: "X", state: "open" }, prPhase: "planning" }] }),
  ];
  let s: DashboardState = initialState();
  for (const ev of events) s = dashboardReducer(s, ev);

  assert.equal(s.maxConcurrency, 2);
  assert.equal(s.cylinders[0]?.status, "active");
  assert.equal(s.cylinderByIssue.get(10), 0);
  assert.equal(s.issueCards.get(10)?.title, "X");
  assert.equal(s.lastLifecyclePairs[0]?.prPhase, "planning");
});
