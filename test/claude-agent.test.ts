import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFinalDescription,
  extractImplementationPayload,
  FINAL_DESCRIPTION_END_MARKER,
  FINAL_DESCRIPTION_START_MARKER,
  IMPLEMENTATION_PAYLOAD_END_MARKER,
  IMPLEMENTATION_PAYLOAD_START_MARKER,
  isRebaseInProgress,
  isClaudeUsageLimitMessage,
  parseOriginHeadBranch,
  parseUsageResetTimeMs,
} from "../src/claude-agent.js";

test("extractFinalDescription returns the text between the sentinel markers", () => {
  const stdout = [
    "Tool: read file",
    "Some chatter...",
    FINAL_DESCRIPTION_START_MARKER,
    "## Summary",
    "",
    "Did the thing.",
    FINAL_DESCRIPTION_END_MARKER,
    "Tool: done",
  ].join("\n");

  assert.equal(extractFinalDescription(stdout), "## Summary\n\nDid the thing.");
});

test("extractFinalDescription falls back to the raw stdout when markers are missing", () => {
  const stdout = "Just a free-form description.";
  assert.equal(extractFinalDescription(stdout), "Just a free-form description.");
});

test("extractImplementationPayload parses the JSON body between markers", () => {
  const json = JSON.stringify({
    title: "Add widget",
    body: "Added the widget.\n\nCloses #1",
  });
  const stdout = [
    "chatter",
    IMPLEMENTATION_PAYLOAD_START_MARKER,
    json,
    IMPLEMENTATION_PAYLOAD_END_MARKER,
  ].join("\n");

  const result = extractImplementationPayload(stdout);
  assert.deepEqual(result, {
    pullRequestTitle: "Add widget",
    pullRequestBody: "Added the widget.\n\nCloses #1",
  });
});

test("extractImplementationPayload returns undefined when markers are missing", () => {
  assert.equal(extractImplementationPayload("no markers here"), undefined);
});

test("extractImplementationPayload returns undefined for malformed JSON", () => {
  const stdout = `${IMPLEMENTATION_PAYLOAD_START_MARKER}\nnot json\n${IMPLEMENTATION_PAYLOAD_END_MARKER}`;
  assert.equal(extractImplementationPayload(stdout), undefined);
});

test("isClaudeUsageLimitMessage detects out-of-extra-usage text", () => {
  const message = "You're out of extra usage - resets 6:40pm (America/Los_Angeles)";
  assert.equal(isClaudeUsageLimitMessage(message), true);
});

test("isClaudeUsageLimitMessage returns false for unrelated errors", () => {
  assert.equal(isClaudeUsageLimitMessage("network timeout"), false);
});

test("parseUsageResetTimeMs parses same-day reset times", () => {
  const now = new Date(2026, 4, 14, 17, 0, 0, 0);
  const parsed = parseUsageResetTimeMs(
    "You're out of extra usage - resets 6:40pm (America/Los_Angeles)",
    now,
  );
  assert.equal(parsed !== undefined, true);
  const date = new Date(parsed!);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 14);
  assert.equal(date.getHours(), 18);
  assert.equal(date.getMinutes(), 40);
});

test("parseUsageResetTimeMs rolls to next day when time already passed", () => {
  const now = new Date(2026, 4, 14, 23, 0, 0, 0);
  const parsed = parseUsageResetTimeMs("usage limit reached, resets 6:40pm", now);
  assert.equal(parsed !== undefined, true);
  const date = new Date(parsed!);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 15);
  assert.equal(date.getHours(), 18);
  assert.equal(date.getMinutes(), 40);
});

test("parseUsageResetTimeMs returns undefined when reset time is missing", () => {
  assert.equal(parseUsageResetTimeMs("You're out of extra usage"), undefined);
});

test("parseOriginHeadBranch extracts branch from origin short ref", () => {
  assert.equal(parseOriginHeadBranch("origin/main"), "main");
});

test("parseOriginHeadBranch extracts branch from full remote ref path", () => {
  assert.equal(parseOriginHeadBranch("refs/remotes/origin/release/2026"), "release/2026");
});

test("parseOriginHeadBranch returns undefined for non-origin refs", () => {
  assert.equal(parseOriginHeadBranch("upstream/main"), undefined);
});

test("isRebaseInProgress returns true when rebase-merge exists", async () => {
  const exists = async (path: string): Promise<boolean> => path.endsWith("/.git/rebase-merge");
  const result = await isRebaseInProgress("/tmp/repo", exists);
  assert.equal(result, true);
});

test("isRebaseInProgress returns true when rebase-apply exists", async () => {
  const exists = async (path: string): Promise<boolean> => path.endsWith("/.git/rebase-apply");
  const result = await isRebaseInProgress("/tmp/repo", exists);
  assert.equal(result, true);
});

test("isRebaseInProgress returns false when no rebase state exists", async () => {
  const exists = async (): Promise<boolean> => false;
  const result = await isRebaseInProgress("/tmp/repo", exists);
  assert.equal(result, false);
});
