import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeAccountManager,
  parseClaudeAccountsEnv,
} from "../src/claude-account-manager.js";

// ── parseClaudeAccountsEnv ───────────────────────────────────────────────────

test("parseClaudeAccountsEnv splits comma-separated entries", () => {
  const result = parseClaudeAccountsEnv("/home/user/.claude-1,/home/user/.claude-2");
  assert.deepEqual(result, ["/home/user/.claude-1", "/home/user/.claude-2"]);
});

test("parseClaudeAccountsEnv splits newline-separated entries", () => {
  const result = parseClaudeAccountsEnv("/home/user/.claude-1\n/home/user/.claude-2");
  assert.deepEqual(result, ["/home/user/.claude-1", "/home/user/.claude-2"]);
});

test("parseClaudeAccountsEnv trims whitespace and ignores blank entries", () => {
  const result = parseClaudeAccountsEnv("  /home/user/.claude-1  \n\n  /home/user/.claude-2  \n");
  assert.deepEqual(result, ["/home/user/.claude-1", "/home/user/.claude-2"]);
});

test("parseClaudeAccountsEnv returns empty array for blank string", () => {
  assert.deepEqual(parseClaudeAccountsEnv(""), []);
  assert.deepEqual(parseClaudeAccountsEnv("  \n  "), []);
});

// ── ClaudeAccountManager — construction ─────────────────────────────────────

test("ClaudeAccountManager throws when no config dirs supplied", () => {
  assert.throws(
    () => new ClaudeAccountManager([]),
    /at least one config directory/i,
  );
});

// ── ClaudeAccountManager — acquireAccount ───────────────────────────────────

test("acquireAccount returns the first directory when no rate limits set", () => {
  const mgr = new ClaudeAccountManager(["/a", "/b"]);
  assert.equal(mgr.acquireAccount(), "/a");
});

test("acquireAccount skips rate-limited accounts and returns the next available one", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["/a", "/b"], storePath);

    // Mark /a as rate-limited in the future.
    await mgr.markRateLimited("/a", Date.now() + 60_000);

    assert.equal(mgr.acquireAccount(), "/b");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("acquireAccount returns undefined when all accounts are rate-limited", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["/a", "/b"], storePath);

    const future = Date.now() + 60_000;
    await mgr.markRateLimited("/a", future);
    await mgr.markRateLimited("/b", future);

    assert.equal(mgr.acquireAccount(), undefined);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("acquireAccount returns account whose rate limit has already expired", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["/a"], storePath);

    // Set a rate limit that already expired (in the past).
    await mgr.markRateLimited("/a", Date.now() - 120_000);

    // The 1-minute buffer is applied to the reset time, so:
    // blocked until = resetTime + 60s = (now - 120s) + 60s = now - 60s (past)
    assert.equal(mgr.acquireAccount(), "/a");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── ClaudeAccountManager — earliestAvailableMs ──────────────────────────────

test("earliestAvailableMs returns undefined when an account is available", () => {
  const mgr = new ClaudeAccountManager(["/a", "/b"]);
  assert.equal(mgr.earliestAvailableMs(), undefined);
});

test("earliestAvailableMs returns the smallest blockedUntilMs when all are limited", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");
    const mgr = new ClaudeAccountManager(["/a", "/b"], storePath);

    const resetA = Date.now() + 30_000;
    const resetB = Date.now() + 60_000;
    // markRateLimited adds the 1-minute buffer internally
    await mgr.markRateLimited("/a", resetA);
    await mgr.markRateLimited("/b", resetB);

    const earliest = mgr.earliestAvailableMs();
    assert.ok(earliest !== undefined);
    // "/a" was blocked until resetA + 60s, "/b" until resetB + 60s; earliest = "/a"
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
    const mgr1 = new ClaudeAccountManager(["/a", "/b"], storePath);
    const resetTime = Date.now() + 30_000;
    await mgr1.markRateLimited("/a", resetTime);

    // A fresh manager instance for the same store path should load the saved state.
    const mgr2 = new ClaudeAccountManager(["/a", "/b"], storePath);
    await mgr2.load();

    // /a should still be rate-limited; /b should be available.
    assert.equal(mgr2.acquireAccount(), "/b");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("load() silently succeeds when the store file does not exist", async () => {
  const mgr = new ClaudeAccountManager(["/a"], join(tmpdir(), "nonexistent-vibrator-acct-store.json"));
  await assert.doesNotReject(() => mgr.load());
  assert.equal(mgr.acquireAccount(), "/a");
});

test("markRateLimited creates parent directories if missing", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "nested", "dir", "accounts.json");
    const mgr = new ClaudeAccountManager(["/a"], storePath);
    await mgr.markRateLimited("/a", Date.now() + 30_000);
    const contents = await readFile(storePath, "utf8");
    const parsed = JSON.parse(contents) as { accounts: { configDir: string }[] };
    assert.equal(parsed.accounts[0]?.configDir, "/a");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("load() ignores accounts in the store that are no longer configured", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "vibrator-acct-"));
  try {
    const storePath = join(tmpDir, "accounts.json");

    // Persist state for /old-account which is not in the new manager.
    const mgr1 = new ClaudeAccountManager(["/old-account"], storePath);
    await mgr1.markRateLimited("/old-account", Date.now() + 60_000);

    // New manager only knows about /a.
    const mgr2 = new ClaudeAccountManager(["/a"], storePath);
    await mgr2.load();
    // /a should be unaffected by the stale /old-account entry.
    assert.equal(mgr2.acquireAccount(), "/a");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── ClaudeAccountManager — accountCount / getStates ─────────────────────────

test("accountCount returns the number of configured accounts", () => {
  const mgr = new ClaudeAccountManager(["/a", "/b", "/c"]);
  assert.equal(mgr.accountCount, 3);
});

test("getStates returns one entry per configured account", () => {
  const mgr = new ClaudeAccountManager(["/a", "/b"]);
  const states = mgr.getStates();
  assert.equal(states.length, 2);
  assert.equal(states[0]!.configDir, "/a");
  assert.equal(states[1]!.configDir, "/b");
});
