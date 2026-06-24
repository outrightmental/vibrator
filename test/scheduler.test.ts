import test from "node:test";
import assert from "node:assert/strict";
import {
  actionResourceKey,
  repoActionKey,
  claimsForRepo,
  claimedImplementationIssueNumbers,
  tryClaimFromPlan,
} from "../src/scheduler.js";
import type { OrchestratorAction } from "../src/types.js";

const impl = (issueNumber: number): OrchestratorAction => ({
  type: "start-implementation",
  issueNumber,
});
const review = (pullRequestNumber: number): OrchestratorAction => ({
  type: "self-review",
  issueNumber: undefined,
  pullRequestNumber,
  pullRequestHeadSha: "deadbeef",
});

// ── claim keys ────────────────────────────────────────────────────────────────

test("actionResourceKey keys by resource, not action type", () => {
  assert.equal(actionResourceKey(impl(7)), "issue:7");
  assert.equal(actionResourceKey(review(12)), "pr:12");
});

test("repoActionKey namespaces resource keys by project", () => {
  assert.equal(repoActionKey("o/a", impl(7)), "o/a issue:7");
  assert.equal(repoActionKey("o/b", impl(7)), "o/b issue:7");
  assert.notEqual(repoActionKey("o/a", impl(7)), repoActionKey("o/b", impl(7)));
});

// ── per-project claim accounting ────────────────────────────────────────────────

test("claimsForRepo counts only the named project's claims", () => {
  const claimed = new Set([
    "o/a issue:1",
    "o/a pr:2",
    "o/b issue:1",
  ]);
  assert.equal(claimsForRepo(claimed, "o/a"), 2);
  assert.equal(claimsForRepo(claimed, "o/b"), 1);
  assert.equal(claimsForRepo(claimed, "o/c"), 0);
});

test("claimsForRepo does not match a repo that is a prefix of another", () => {
  const claimed = new Set(["o/app issue:1"]);
  assert.equal(claimsForRepo(claimed, "o/app"), 1);
  assert.equal(claimsForRepo(claimed, "o/ap"), 0, "must not prefix-match o/app");
});

test("claimedImplementationIssueNumbers returns only that project's implementing issues", () => {
  const claimed = new Set([
    "o/a issue:7",
    "o/a pr:3",
    "o/b issue:9",
  ]);
  assert.deepEqual([...claimedImplementationIssueNumbers(claimed, "o/a")], [7]);
  assert.deepEqual([...claimedImplementationIssueNumbers(claimed, "o/b")], [9]);
});

// ── shared-pool allocation with per-project caps ────────────────────────────────

test("tryClaimFromPlan claims the first unclaimed action and records it", () => {
  const claimed = new Set<string>();
  const action = tryClaimFromPlan("o/a", 2, [impl(1), impl(2)], claimed);
  assert.deepEqual(action, impl(1));
  assert.ok(claimed.has("o/a issue:1"));
});

test("tryClaimFromPlan skips actions already claimed (no double-booking a resource)", () => {
  const claimed = new Set<string>(["o/a issue:1"]);
  const action = tryClaimFromPlan("o/a", 4, [impl(1), impl(2)], claimed);
  assert.deepEqual(action, impl(2), "should skip the already-claimed issue 1");
});

test("tryClaimFromPlan returns null once a project is at its cap", () => {
  // Cap of 2, already two cylinders on this project → no further claim allowed,
  // even though the plan still proposes work.
  const claimed = new Set<string>(["o/a issue:1", "o/a pr:9"]);
  const action = tryClaimFromPlan("o/a", 2, [impl(2), impl(3)], claimed);
  assert.equal(action, null);
  assert.equal(claimed.size, 2, "no new claim recorded");
});

test("per-project caps hold while the shared pool drains across projects in order", () => {
  // A cap 2, B cap 2, C cap 1. Configured order prefers A, then B, then C.
  // (The global pool size is enforced by the engine count, not by this helper;
  // here we exercise that each project never exceeds its own cap and that
  // earlier projects are filled first.)
  const projects = [
    { repoKey: "o/a", cap: 2, actions: [impl(1), impl(2), impl(3)] },
    { repoKey: "o/b", cap: 2, actions: [impl(10), impl(11), impl(12)] },
    { repoKey: "o/c", cap: 1, actions: [impl(20), impl(21)] },
  ];
  const claimed = new Set<string>();

  const grabOne = (): string | null => {
    for (const p of projects) {
      const a = tryClaimFromPlan(p.repoKey, p.cap, p.actions, claimed);
      if (a) return p.repoKey;
    }
    return null;
  };

  // First four cylinders fill A (×2) then B (×2) — C is untouched while earlier
  // projects still have headroom.
  assert.deepEqual([grabOne(), grabOne(), grabOne(), grabOne()], ["o/a", "o/a", "o/b", "o/b"]);
  assert.equal(claimsForRepo(claimed, "o/a"), 2);
  assert.equal(claimsForRepo(claimed, "o/b"), 2);
  assert.equal(claimsForRepo(claimed, "o/c"), 0);

  // A and B are now capped, so the next cylinder is the only one C may have.
  assert.equal(grabOne(), "o/c");
  assert.equal(claimsForRepo(claimed, "o/c"), 1);

  // Everything is at cap now — no project has headroom.
  assert.equal(grabOne(), null);
  assert.equal(claimsForRepo(claimed, "o/a"), 2);
  assert.equal(claimsForRepo(claimed, "o/b"), 2);
  assert.equal(claimsForRepo(claimed, "o/c"), 1);
});

test("releasing a claim frees a cap slot for the next cylinder", () => {
  const claimed = new Set<string>(["o/a issue:1", "o/a pr:2"]);
  assert.equal(tryClaimFromPlan("o/a", 2, [impl(3)], claimed), null, "at cap");
  claimed.delete("o/a pr:2"); // a cylinder finished its PR work
  assert.deepEqual(tryClaimFromPlan("o/a", 2, [impl(3)], claimed), impl(3), "slot freed");
});
