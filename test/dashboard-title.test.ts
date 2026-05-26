import test from "node:test";
import assert from "node:assert/strict";

import { resolveDashboardTitle } from "../src/dashboard-title.js";

test("resolveDashboardTitle prefers explicit DASHBOARD_TITLE", () => {
  const title = resolveDashboardTitle(
    "My Dashboard",
    "repo",
    { projectNumber: 99, reviewers: ["alice"] },
    "Project Board",
  );
  assert.equal(title, "My Dashboard");
});

test("resolveDashboardTitle defaults to project title in project mode", () => {
  const title = resolveDashboardTitle(
    undefined,
    "repo",
    { projectNumber: 99, reviewers: [] },
    "Project Board",
  );
  assert.equal(title, "Project Board");
});

test("resolveDashboardTitle falls back to repo name in simple mode", () => {
  const title = resolveDashboardTitle(undefined, "repo", undefined, undefined);
  assert.equal(title, "repo");
});
