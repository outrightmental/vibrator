import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvConfig, resolveGitHubToken, type EnvConfig } from "../src/env-config.js";

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

async function writeEnvJson(dir: string, content: unknown): Promise<string> {
  const filePath = join(dir, "env.json");
  await writeFile(filePath, JSON.stringify(content), "utf-8");
  return filePath;
}

const minimalValidConfig = {
  github_tokens: [{ name: "default", token: "ghp_test123", default: true }],
  projects: [{ github_repository: "owner/repo" }],
};

test("loadEnvConfig loads a valid minimal config", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvJson(dir, minimalValidConfig);
    const config = loadEnvConfig(filePath);
    assert.equal(config.github_tokens.length, 1);
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0]!.github_repository, "owner/repo");
  });
});

test("loadEnvConfig loads a full config with all optional fields", async () => {
  await withTempDir(async (dir) => {
    const full = {
      claude_code_model: "claude-sonnet-4-6",
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
          claude_code_model: "claude-opus-4-8",
          claude_describe_model: "claude-haiku-4-5",
          cycle_minimum_seconds: 45,
          dashboard_port: 3001,
          dashboard_title: "Project A",
          session_store_path: "/tmp/sessions.json",
        },
        {
          github_repository: "org/projectB",
          github_token_name: "secondary",
        },
      ],
    };
    const filePath = await writeEnvJson(dir, full);
    const config = loadEnvConfig(filePath);
    assert.equal(config.claude_code_model, "claude-sonnet-4-6");
    assert.equal(config.max_concurrency, 5);
    assert.equal(config.github_tokens.length, 2);
    assert.equal(config.projects.length, 2);
    assert.equal(config.projects[0]!.github_project_number, 7);
    assert.deepEqual(config.projects[0]!.reviewers, ["alice", "bob"]);
    assert.equal(config.projects[0]!.focus_mode, true);
  });
});

test("loadEnvConfig throws when file does not exist", () => {
  assert.throws(
    () => loadEnvConfig("/nonexistent/path/env.json"),
    /Configuration file not found/,
  );
});

test("loadEnvConfig throws on invalid JSON", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "env.json");
    await writeFile(filePath, "{ not valid json }", "utf-8");
    assert.throws(() => loadEnvConfig(filePath), /Failed to parse/);
  });
});

test("loadEnvConfig throws when github_tokens is missing", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvJson(dir, {
      projects: [{ github_repository: "owner/repo" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"github_tokens" must be a non-empty array/);
  });
});

test("loadEnvConfig throws when github_tokens is empty", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvJson(dir, {
      github_tokens: [],
      projects: [{ github_repository: "owner/repo" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"github_tokens" must be a non-empty array/);
  });
});

test("loadEnvConfig throws when projects is missing", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvJson(dir, {
      github_tokens: [{ name: "default", token: "ghp_test" }],
    });
    assert.throws(() => loadEnvConfig(filePath), /"projects" must be a non-empty array/);
  });
});

test("loadEnvConfig throws when projects is empty", async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeEnvJson(dir, {
      github_tokens: [{ name: "default", token: "ghp_test" }],
      projects: [],
    });
    assert.throws(() => loadEnvConfig(filePath), /"projects" must be a non-empty array/);
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
