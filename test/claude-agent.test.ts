import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFinalDescription,
  extractImplementationPayload,
  FINAL_DESCRIPTION_END_MARKER,
  FINAL_DESCRIPTION_START_MARKER,
  IMPLEMENTATION_PAYLOAD_END_MARKER,
  IMPLEMENTATION_PAYLOAD_START_MARKER,
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
