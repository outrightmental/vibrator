import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for #204 — the dashboard went perpetually "Connecting…" and
// only updated on a full page reload.
//
// Root cause: the esbuild dashboard bundle was built against the root tsconfig
// (`target: es2022`), which defaults `useDefineForClassFields` to true. That
// emits Lit component class fields as instance `defineProperty` calls, which
// SHADOW the reactive property accessors Lit installs from `static properties`.
// With the accessors shadowed, assigning a reactive property never triggers
// `requestUpdate()`, so components stop re-rendering on state changes.
//
// The fix builds the dashboard with `useDefineForClassFields: false`. These
// tests pin both the tsconfig setting and the bundle output so the regression
// can't silently return.

const ROOT = join(import.meta.dirname, "..");

test("dashboard tsconfig disables useDefineForClassFields (Lit reactivity)", () => {
  const raw = readFileSync(join(ROOT, "src", "dashboard", "tsconfig.json"), "utf-8");
  // Strip // comments so JSON.parse accepts the (commented) tsconfig.
  const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
    compilerOptions?: { useDefineForClassFields?: boolean };
  };
  assert.equal(
    json.compilerOptions?.useDefineForClassFields,
    false,
    "src/dashboard/tsconfig.json must set useDefineForClassFields:false or Lit components stop re-rendering (#204)",
  );
});

test("build:dashboard passes the dashboard tsconfig to esbuild", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  };
  for (const name of ["build:dashboard", "watch:dashboard"]) {
    assert.match(
      pkg.scripts[name] ?? "",
      /--tsconfig=src\/dashboard\/tsconfig\.json/,
      `${name} must build with --tsconfig=src/dashboard/tsconfig.json so useDefineForClassFields:false is applied (#204)`,
    );
  }
});
