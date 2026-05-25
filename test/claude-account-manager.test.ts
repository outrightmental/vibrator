import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeAccountManager,
} from "../src/claude-account-manager.js";

// ── ClaudeAccountManager — construction ─────────────────────────────────────

test("ClaudeAccountManager throws when no account emails supplied", () => {
  assert.throws(
    () => new ClaudeAccountManager([]),
    /at least one account email/i,
  );
});

test("ClaudeAccountManager normalizes and deduplicates account emails", () => {
  const mgr = new ClaudeAccountManager([" User@Example.com ", "user@example.com", "other@example.com"]);
  assert.equal(mgr.accountCount, 2);
});

// ── ClaudeAccountManager — acquireAccount ───────────────────────────────────

test("acquireAccount returns the first credential when no rate limits set", () => {
  const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"]);
  assert.equal(mgr.acquireAccount(), "a@example.com");
});

test("acquireAccount skips rate-limited accounts and returns the next available one", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"], storePath);

    // Mark first credential as rate-limited in the future.
    await mgr.markRateLimited("a@example.com", Date.now() + 60_000);

    assert.equal(mgr.acquireAccount(), "b@example.com");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("acquireAccount returns undefined when all accounts are rate-limited", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"], storePath);

    const future = Date.now() + 60_000;
    await mgr.markRateLimited("a@example.com", future);
    await mgr.markRateLimited("b@example.com", future);

    assert.equal(mgr.acquireAccount(), undefined);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("acquireAccount returns account whose rate limit has already expired", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["a@example.com"], storePath);

    // Set a rate limit that already expired (in the past).
    await mgr.markRateLimited("a@example.com", Date.now() - 120_000);

    // The 1-minute buffer is applied to the reset time, so:
    // blocked until = resetTime + 60s = (now - 120s) + 60s = now - 60s (past)
    assert.equal(mgr.acquireAccount(), "a@example.com");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── ClaudeAccountManager — earliestAvailableMs ──────────────────────────────

test("earliestAvailableMs returns undefined when an account is available", () => {
  const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"]);
  assert.equal(mgr.earliestAvailableMs(), undefined);
});

test("earliestAvailableMs returns the smallest blockedUntilMs when all are limited", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"], storePath);

    const resetA = Date.now() + 30_000;
    const resetB = Date.now() + 60_000;
    // markRateLimited adds the 1-minute buffer internally
    await mgr.markRateLimited("a@example.com", resetA);
    await mgr.markRateLimited("b@example.com", resetB);

    const earliest = mgr.earliestAvailableMs();
    assert.ok(earliest !== undefined);
    // "a" was blocked until resetA + 60s, "b" until resetB + 60s; earliest = "a"
    assert.equal(earliest, resetA + 60_000);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── ClaudeAccountManager — persistence ──────────────────────────────────────

test("markRateLimited persists state to disk and load() restores it", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr1 = new ClaudeAccountManager(["a@example.com", "b@example.com"], storePath);
    const resetTime = Date.now() + 30_000;
    await mgr1.markRateLimited("a@example.com", resetTime);

    // A fresh manager instance for the same store path should load the saved state.
    const mgr2 = new ClaudeAccountManager(["a@example.com", "b@example.com"], storePath);
    await mgr2.load();

    // a should still be rate-limited; b should be available.
    assert.equal(mgr2.acquireAccount(), "b@example.com");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("load() silently succeeds when the store file does not exist", async () => {
  const mgr = new ClaudeAccountManager(["a@example.com"], join(tmpdir(), "nonexistent-vibrator-acct-store.json"));
  await assert.doesNotReject(() => mgr.load());
  assert.equal(mgr.acquireAccount(), "a@example.com");
});

test("markRateLimited creates parent directories if missing", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "nested", "dir", "accounts.json");
    const mgr = new ClaudeAccountManager(["a@example.com"], storePath);
    await mgr.markRateLimited("a@example.com", Date.now() + 30_000);
    const contents = await readFile(storePath, "utf8");
    const parsed = JSON.parse(contents) as { credentials: { email: string }[] };
    assert.equal(parsed.credentials[0]?.email, "a@example.com");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("load() ignores accounts in the store that are no longer configured", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");

    // Persist state for old credential that is not in the new manager.
    const mgr1 = new ClaudeAccountManager(["old@example.com"], storePath);
    await mgr1.markRateLimited("old@example.com", Date.now() + 60_000);

    // New manager only knows about a@example.com.
    const mgr2 = new ClaudeAccountManager(["a@example.com"], storePath);
    await mgr2.load();
    assert.equal(mgr2.acquireAccount(), "a@example.com");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── ClaudeAccountManager — accountCount / getStates ─────────────────────────

test("accountCount returns the number of configured accounts", () => {
  const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com", "c@example.com"]);
  assert.equal(mgr.accountCount, 3);
});

test("getStates returns one entry per configured account", () => {
  const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"]);
  const states = mgr.getStates();
  assert.equal(states.length, 2);
  assert.equal(states[0]!.email, "a@example.com");
  assert.equal(states[1]!.email, "b@example.com");
});

test("markUnavailable removes an account from future rotation", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"], storePath);
    await mgr.markUnavailable("a@example.com");
    assert.equal(mgr.acquireAccount(), "b@example.com");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("availableAccountCount excludes unavailable credentials", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["a@example.com", "b@example.com"], storePath);
    await mgr.markUnavailable("a@example.com");
    assert.equal(mgr.availableAccountCount, 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
