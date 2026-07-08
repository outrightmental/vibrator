import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump as dumpYaml } from "js-yaml";

import { loadEnvConfig, resolveGitHubToken, applyProjectDefaults, type EnvConfig, type ProjectEnvConfig } from "../src/env-config.js";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vibrator-env-config-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeEnvYaml(dir: string, content: unknown): Promise<string> {
  const filePath = join(dir, "env.yaml");
  await writeFile(filePath, dumpYaml(content), "utf-8");
  return filePath;
}

const minimalValidConfig = {
  github_tokens: [{ name: "default", token: "ghp_test123", default: true }],
  projects: [{ github_repository: "owner/repo" }],
};

test("loadEnvConfig loads a valid minimal config", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, minimalValidConfig);
    const config = loadEnvConfig(filePath);
    assert.equal(config.github_tokens.length, 1);
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0]!.github_repository, "owner/repo");
  });
});

test("loadEnvConfig loads a full config with all optional fields", async () => {
  await withTempDir(async (dir) => {
    const full = {
      claude_code_initial_model: "claude-sonnet-4-6",
      claude_code_review_model: "claude-opus-4-8",
      claude_code_initial_effort: "high",
      claude_code_review_effort: "high",
      claude_describe_model: "claude-haiku-4-5",
      max_concurrency: 5,
      cycle_minimum_seconds: 30,
      github_api_base_url: "https://github.example.com/api/v3",
      github_api_version: "2022-11-28",
      github_tokens: [
        { name: "primary", token: "ghp_primary", default: true },
        { name: "secondary", token: "ghp_secondary" },
      ],
      projects: [
        {
          github_repository: "org/projectA",
          github_token_name: "primary",
          github_project_number: 7,
          reviewers: ["alice", "bob"],
          focus_mode: true,
          max_concurrency: 2,
          claude_code_initial_model: "claude-opus-4-8",
          claude_code_review_model: "claude-opus-4-8",
          claude_describe_model: "claude-haiku-4-5",
          cycle_minimum_seconds: 45,
          dashboard_port: 3001,
          session_store_path: "/tmp/sessions.json",
        },
        {
          github_repository: "org/projectB",
          github_token_name: "secondary",
        },
      ],
    };
    const filePath = await writeEnvYaml(dir, full);
    const config = loadEnvConfig(filePath);
    assert.equal(config.claude_code_initial_model, "claude-sonnet-4-6");
    assert.equal(config.max_concurrency, 5);
    assert.equal(config.github_tokens.length, 2);
    assert.equal(config.projects.length, 2);
    assert.equal(config.projects[0]!.github_project_number, 7);
    assert.deepEqual(config.projects[0]!.reviewers, ["alice", "bob"]);
    assert.equal(config.projects[0]!.focus_mode, true);
  });
});

test("loadEnvConfig correctly ignores YAML comments", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "env.yaml");
    const yaml = [
      "# Top-level comment explaining the file",
      "github_tokens:",
      "  - name: default",
      "    token: ghp_test123 # inline comment on the token",
      "    default: true",
      "# projects comment",
      "projects:",
      "  - github_repository: owner/repo # another inline comment",
    ].join("\n");
    await writeFile(filePath, yaml, "utf-8");
    const config = loadEnvConfig(filePath);
    assert.equal(config.github_tokens[0]!.token, "ghp_test123");
    assert.equal(config.projects[0]!.github_repository, "owner/repo");
  });
});

test("loadEnvConfig throws when file does not exist", () => {
  assert.throws(
    () => loadEnvConfig("/nonexistent/path/env.yaml"),
    /Configuration file not found/,
  );
});

test("loadEnvConfig throws on invalid YAML", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "env.yaml");
    await writeFile(filePath, "key: [\nbad yaml", "utf-8");
    assert.throws(() => loadEnvConfig(filePath), /Failed to parse/);
  });
});

test("loadEnvConfig throws when github_tokens is missing", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      projects: [{ github_repository: "owner/repo" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"github_tokens" must be a non-empty array/);
  });
});

test("loadEnvConfig throws when github_tokens is empty", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      github_tokens: [],
      projects: [{ github_repository: "owner/repo" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"github_tokens" must be a non-empty array/);
  });
});

test("loadEnvConfig throws when projects is missing", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      github_tokens: [{ name: "default", token: "ghp_test" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"projects" must be a non-empty array/);
  });
});

test("loadEnvConfig throws when projects is empty", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      github_tokens: [{ name: "default", token: "ghp_test" }],
      projects: [],
    });
    assert.throws(() => loadEnvConfig(filePath), /"projects" must be a non-empty array/);
  });
});

test("loadEnvConfig throws when a token entry is missing name", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      github_tokens: [{ token: "ghp_test" }],
      projects: [{ github_repository: "owner/repo" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"github_tokens\[0\]\.name" must be a non-empty string/);
  });
});

test("loadEnvConfig throws when a token entry is missing token", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      github_tokens: [{ name: "default" }],
      projects: [{ github_repository: "owner/repo" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"github_tokens\[0\]\.token" must be a non-empty string/);
  });
});

test("loadEnvConfig throws when a project entry is missing github_repository", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      github_tokens: [{ name: "default", token: "ghp_test" }],
      projects: [{}],
    });
    assert.throws(() => loadEnvConfig(filePath), /"projects\[0\]\.github_repository" must be a non-empty string/);
  });
});

test("loadEnvConfig throws when global claude_code_model is present", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      ...minimalValidConfig,
      claude_code_model: "claude-sonnet-4-6",
    });
    assert.throws(
      () => loadEnvConfig(filePath),
      /"claude_code_model" is no longer supported/,
    );
  });
});

test("loadEnvConfig throws when per-project claude_code_model is present", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvYaml(dir, {
      github_tokens: [{ name: "default", token: "ghp_test", default: true }],
      projects: [{ github_repository: "owner/repo", claude_code_model: "claude-sonnet-4-6" }],
    });
    assert.throws(
      () => loadEnvConfig(filePath),
      /"projects\[0\]\.claude_code_model" is no longer supported/,
    );
  });
});

test("resolveGitHubToken returns the default token (marked with default: true)", () => {
  const config: EnvConfig = {
    github_tokens: [
      { name: "secondary", token: "  ghp_secondary  " },
      { name: "primary", token: "  ghp_primary  ", default: true },
    ],
    projects: [],
  };
  assert.equal(resolveGitHubToken(config), "ghp_primary");
});

test("resolveGitHubToken falls back to first token when none is marked default", () => {
  const config: EnvConfig = {
    github_tokens: [
      { name: "first", token: "  ghp_first  " },
      { name: "second", token: "ghp_second" },
    ],
    projects: [],
  };
  assert.equal(resolveGitHubToken(config), "ghp_first");
});

test("resolveGitHubToken resolves a named token", () => {
  const config: EnvConfig = {
    github_tokens: [
      { name: "alpha", token: "ghp_alpha", default: true },
      { name: "beta", token: "  ghp_beta  " },
    ],
    projects: [],
  };
  assert.equal(resolveGitHubToken(config, "beta"), "ghp_beta");
});

test("resolveGitHubToken throws when the named token does not exist", () => {
  const config: EnvConfig = {
    github_tokens: [{ name: "alpha", token: "ghp_alpha" }],
    projects: [],
  };
  assert.throws(
    () => resolveGitHubToken(config, "nonexistent"),
    /GitHub token named "nonexistent" not found/,
  );
});

test("resolveGitHubToken trims whitespace from token values", () => {
  const config: EnvConfig = {
    github_tokens: [{ name: "tok", token: "  ghp_trimmed  ", default: true }],
    projects: [],
  };
  assert.equal(resolveGitHubToken(config), "ghp_trimmed");
});

// ── applyProjectDefaults ──────────────────────────────────────────────────────

const baseEnvConfig: EnvConfig = {
  github_tokens: [{ name: "default", token: "t" }],
  projects: [],
};

test("applyProjectDefaults uses global max_concurrency when project does not override", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r" },
    { ...baseEnvConfig, max_concurrency: 5 },
  );
  assert.equal(result.max_concurrency, 5);
});

test("applyProjectDefaults caps per-project max_concurrency at the global value", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", max_concurrency: 10 },
    { ...baseEnvConfig, max_concurrency: 3 },
  );
  assert.equal(result.max_concurrency, 3);
});

test("applyProjectDefaults respects per-project max_concurrency when below global", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", max_concurrency: 2 },
    { ...baseEnvConfig, max_concurrency: 5 },
  );
  assert.equal(result.max_concurrency, 2);
});

test("applyProjectDefaults defaults max_concurrency to 3 when neither level specifies it", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.max_concurrency, 3);
});

test("applyProjectDefaults uses per-project claude_code_initial_model over global", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", claude_code_initial_model: "claude-opus-4-8" },
    { ...baseEnvConfig, claude_code_initial_model: "claude-sonnet-4-6" },
  );
  assert.equal(result.claude_code_initial_model, "claude-opus-4-8");
});

test("applyProjectDefaults falls back to global claude_code_initial_model", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r" },
    { ...baseEnvConfig, claude_code_initial_model: "claude-sonnet-4-6" },
  );
  assert.equal(result.claude_code_initial_model, "claude-sonnet-4-6");
});

test("applyProjectDefaults defaults claude_code_initial_model to claude-sonnet-4-6", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.claude_code_initial_model, "claude-sonnet-4-6");
});

test("applyProjectDefaults uses per-project claude_code_review_model over global", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", claude_code_review_model: "claude-sonnet-4-6" },
    { ...baseEnvConfig, claude_code_review_model: "claude-opus-4-8" },
  );
  assert.equal(result.claude_code_review_model, "claude-sonnet-4-6");
});

test("applyProjectDefaults falls back to global claude_code_review_model", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r" },
    { ...baseEnvConfig, claude_code_review_model: "claude-opus-4-8" },
  );
  assert.equal(result.claude_code_review_model, "claude-opus-4-8");
});

test("applyProjectDefaults defaults claude_code_review_model to claude-opus-4-8", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.claude_code_review_model, "claude-opus-4-8");
});

test("applyProjectDefaults uses per-project claude_code_initial_effort over global", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", claude_code_initial_effort: "low" },
    { ...baseEnvConfig, claude_code_initial_effort: "medium" },
  );
  assert.equal(result.claude_code_initial_effort, "low");
});

test("applyProjectDefaults falls back to global claude_code_initial_effort", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r" },
    { ...baseEnvConfig, claude_code_initial_effort: "medium" },
  );
  assert.equal(result.claude_code_initial_effort, "medium");
});

test("applyProjectDefaults defaults claude_code_initial_effort to high", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.claude_code_initial_effort, "high");
});

test("applyProjectDefaults uses per-project claude_code_review_effort over global", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", claude_code_review_effort: "low" },
    { ...baseEnvConfig, claude_code_review_effort: "medium" },
  );
  assert.equal(result.claude_code_review_effort, "low");
});

test("applyProjectDefaults falls back to global claude_code_review_effort", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r" },
    { ...baseEnvConfig, claude_code_review_effort: "medium" },
  );
  assert.equal(result.claude_code_review_effort, "medium");
});

test("applyProjectDefaults defaults claude_code_review_effort to high", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.claude_code_review_effort, "high");
});

test("applyProjectDefaults uses per-project claude_describe_model over global", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", claude_describe_model: "claude-haiku-4-5" },
    { ...baseEnvConfig, claude_describe_model: "claude-sonnet-4-6" },
  );
  assert.equal(result.claude_describe_model, "claude-haiku-4-5");
});

test("applyProjectDefaults falls back to global claude_describe_model", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r" },
    { ...baseEnvConfig, claude_describe_model: "claude-haiku-4-5" },
  );
  assert.equal(result.claude_describe_model, "claude-haiku-4-5");
});

test("applyProjectDefaults returns undefined claude_describe_model when neither level sets it", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.claude_describe_model, undefined);
});

test("applyProjectDefaults uses per-project cycle_minimum_seconds over global", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", cycle_minimum_seconds: 30 },
    { ...baseEnvConfig, cycle_minimum_seconds: 120 },
  );
  assert.equal(result.cycle_minimum_seconds, 30);
});

test("applyProjectDefaults falls back to global cycle_minimum_seconds", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r" },
    { ...baseEnvConfig, cycle_minimum_seconds: 90 },
  );
  assert.equal(result.cycle_minimum_seconds, 90);
});

test("applyProjectDefaults defaults cycle_minimum_seconds to 60", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.cycle_minimum_seconds, 60);
});

test("applyProjectDefaults applies focus_mode from project config", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", focus_mode: true },
    baseEnvConfig,
  );
  assert.equal(result.focus_mode, true);
});

test("applyProjectDefaults defaults focus_mode to false", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.equal(result.focus_mode, false);
});

test("applyProjectDefaults applies reviewers from project config", () => {
  const result = applyProjectDefaults(
    { github_repository: "o/r", reviewers: ["alice", "bob"] },
    baseEnvConfig,
  );
  assert.deepEqual(result.reviewers, ["alice", "bob"]);
});

test("applyProjectDefaults defaults reviewers to empty array", () => {
  const result = applyProjectDefaults({ github_repository: "o/r" }, baseEnvConfig);
  assert.deepEqual(result.reviewers, []);
});
