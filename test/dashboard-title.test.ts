import test from "node:test";
import assert from "node:assert/strict";

import { resolveDashboardTitle, DEFAULT_DASHBOARD_TITLE } from "../src/dashboard-title.js";

test("resolveDashboardTitle returns configured title when set", () => {
  assert.equal(resolveDashboardTitle("My Dashboard"), "My Dashboard");
});

test("resolveDashboardTitle returns default title when undefined", () => {
  assert.equal(resolveDashboardTitle(undefined), DEFAULT_DASHBOARD_TITLE);
  assert.equal(resolveDashboardTitle(undefined), "Outright Mental");
});

test("resolveDashboardTitle returns default title when empty string", () => {
  assert.equal(resolveDashboardTitle(""), "Outright Mental");
});

test("resolveDashboardTitle returns default title when whitespace only", () => {
  assert.equal(resolveDashboardTitle("   "), "Outright Mental");
});
