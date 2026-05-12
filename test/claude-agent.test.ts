import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFinalDescription,
  extractImplementationPayload,
  extractReviewPayload,
  FINAL_DESCRIPTION_END_MARKER,
  FINAL_DESCRIPTION_START_MARKER,
  IMPLEMENTATION_PAYLOAD_END_MARKER,
  IMPLEMENTATION_PAYLOAD_START_MARKER,
  REVIEW_PAYLOAD_END_MARKER,
  REVIEW_PAYLOAD_START_MARKER,
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

test("extractReviewPayload parses summary and inline comments from JSON", () => {
  const json = JSON.stringify({
    summary: "Two issues found.",
    comments: [
      { path: "src/a.ts", line: 12, body: "Rename." },
      { path: "src/b.ts", line: 7, body: "Add test." },
    ],
  });
  const stdout = [
    "chatter",
    REVIEW_PAYLOAD_START_MARKER,
    json,
    REVIEW_PAYLOAD_END_MARKER,
    "more chatter",
  ].join("\n");

  const result = extractReviewPayload(stdout);
  assert.equal(result.summary, "Two issues found.");
  assert.equal(result.inlineComments.length, 2);
  assert.deepEqual(result.inlineComments[0], {
    path: "src/a.ts",
    line: 12,
    body: "Rename.",
  });
});

test("extractReviewPayload returns no inline comments for an LGTM review", () => {
  const json = JSON.stringify({ summary: "LGTM", comments: [] });
  const stdout = `${REVIEW_PAYLOAD_START_MARKER}\n${json}\n${REVIEW_PAYLOAD_END_MARKER}`;
  const result = extractReviewPayload(stdout);
  assert.equal(result.summary, "LGTM");
  assert.deepEqual(result.inlineComments, []);
});

test("extractReviewPayload tolerates malformed JSON by returning the raw payload as summary", () => {
  const stdout = `${REVIEW_PAYLOAD_START_MARKER}\nnot json\n${REVIEW_PAYLOAD_END_MARKER}`;
  const result = extractReviewPayload(stdout);
  assert.equal(result.summary, "not json");
  assert.deepEqual(result.inlineComments, []);
});

test("extractReviewPayload skips inline comments missing required fields", () => {
  const json = JSON.stringify({
    summary: "Some issues",
    comments: [
      { path: "src/a.ts", line: 1, body: "OK" },
      { path: "src/b.ts", body: "Missing line — must be dropped" },
      { path: "src/c.ts", line: 5, body: "" },
      { line: 2, body: "Missing path — drop" },
    ],
  });
  const stdout = `${REVIEW_PAYLOAD_START_MARKER}\n${json}\n${REVIEW_PAYLOAD_END_MARKER}`;
  const result = extractReviewPayload(stdout);
  assert.deepEqual(result.inlineComments, [
    { path: "src/a.ts", line: 1, body: "OK" },
  ]);
});

test("extractReviewPayload treats unmarked output as a free-text approval", () => {
  const result = extractReviewPayload("LGTM, nothing to change.");
  assert.equal(result.summary, "LGTM, nothing to change.");
  assert.deepEqual(result.inlineComments, []);
});

test("extractReviewPayload extracts JSON review from unmarked output when sentinels are missing", () => {
  const json = JSON.stringify({
    summary: "Two issues found.",
    comments: [
      { path: "src/a.ts", line: 12, body: "Rename this." },
      { path: "src/b.ts", line: 7, body: "Add test." },
    ],
  });
  const stdout = `Some chatter from Claude tool use\n${json}\nMore chatter`;

  const result = extractReviewPayload(stdout);
  assert.equal(result.summary, "Two issues found.");
  assert.equal(result.inlineComments.length, 2);
  assert.deepEqual(result.inlineComments[0], {
    path: "src/a.ts",
    line: 12,
    body: "Rename this.",
  });
});

test("extractReviewPayload extracts clean review JSON from unmarked output", () => {
  const json = JSON.stringify({
    summary: "LGTM — everything looks correct.",
    comments: [],
  });
  const stdout = `Thinking about the code…\n${json}\nDone.`;

  const result = extractReviewPayload(stdout);
  assert.equal(result.summary, "LGTM — everything looks correct.");
  assert.deepEqual(result.inlineComments, []);
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
