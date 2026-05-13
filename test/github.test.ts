import test from "node:test";
import assert from "node:assert/strict";

import { isVibratorReview, VIBRATOR_REVIEW_MARKER } from "../src/github.js";

test("isVibratorReview returns true when the review body carries the marker", () => {
  assert.equal(
    isVibratorReview(`${VIBRATOR_REVIEW_MARKER}\n\nLooks good.`),
    true,
  );
});

test("isVibratorReview returns false for reviews from other sources", () => {
  assert.equal(isVibratorReview("LGTM"), false);
  assert.equal(isVibratorReview(null), false);
  assert.equal(isVibratorReview(undefined), false);
});
