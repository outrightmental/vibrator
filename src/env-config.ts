import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface GitHubTokenConfig {
  name: string;
  token: string;
  default?: boolean;
}

export interface ProjectEnvConfig {
  /** Token name from github_tokens to use. Defaults to the token marked default, or the first. */
  github_token_name?: string;
  /** Repository slug in owner/repo format. */
  github_repository: string;
  /** GitHub Projects v2 board number. When set, enables project mode. */
  github_project_number?: number;
  /** GitHub logins to request review from (project mode only). */
  reviewers?: string[];
  /** When true, only issues labelled "focus" are picked up. Default false. */
  focus_mode?: boolean;
  /** Max concurrent work items for this project. Capped at global max_concurrency. */
  max_concurrency?: number;
  /** Claude model for implementation. Defaults to global claude_code_model. */
  claude_code_model?: string;
  /** Claude model for PR descriptions. Defaults to global claude_describe_model. */
  claude_describe_model?: string;
  /** Minimum seconds between engine cycle starts. Defaults to global cycle_minimum_seconds. */
  cycle_minimum_seconds?: number;
  /** Port for the project dashboard. Defaults to 3000, incrementing per project. */
  dashboard_port?: number;
  /** Title displayed in the dashboard header. Defaults to repo name. */
  dashboard_title?: string;
  /** Path for persisted agent-session state. Defaults to .vibrator/<owner>-<repo>-sessions.json. */
  session_store_path?: string;
}

export interface EnvConfig {
  /** Claude model for implementation across all projects (default: claude-sonnet-4-6). */
  claude_code_model?: string;
  /** Claude model for PR descriptions across all projects (default: claude-haiku-4-5). */
  claude_describe_model?: string;
  /** Global maximum concurrent work items across all engines (default: 3). */
  max_concurrency?: number;
  /** Global minimum seconds between engine cycle starts (default: 60). */
  cycle_minimum_seconds?: number;
  /** GitHub API base URL, for GitHub Enterprise (default: https://api.github.com). */
  github_api_base_url?: string;
  /** GitHub API version header (default: 2022-11-28). */
  github_api_version?: string;
  /** Named GitHub tokens. At least one required. */
  github_tokens: GitHubTokenConfig[];
  /** Projects to run. At least one required. */
  projects: ProjectEnvConfig[];
}

export function loadEnvConfig(configPath?: string): EnvConfig {
  const filePath = configPath ?? join(process.cwd(), "env.json");
  if (!existsSync(filePath)) {
    throw new Error(
      `Configuration file not found: ${filePath}\nCreate env.json based on env.example.json.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  const config = raw as Record<string, unknown>;
  if (!Array.isArray(config.github_tokens) || config.github_tokens.length === 0) {
    throw new Error(`${filePath}: "github_tokens" must be a non-empty array.`);
  }
  for (let i = 0; i < config.github_tokens.length; i++) {
    const t = config.github_tokens[i] as Record<string, unknown>;
    if (!t || typeof t !== "object") {
      throw new Error(`${filePath}: "github_tokens[${i}]" must be an object.`);
    }
    if (typeof t.name !== "string" || !t.name.trim()) {
      throw new Error(`${filePath}: "github_tokens[${i}].name" must be a non-empty string.`);
    }
    if (typeof t.token !== "string" || !t.token.trim()) {
      throw new Error(`${filePath}: "github_tokens[${i}].token" must be a non-empty string.`);
    }
  }
  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    throw new Error(`${filePath}: "projects" must be a non-empty array.`);
  }
  for (let i = 0; i < config.projects.length; i++) {
    const p = config.projects[i] as Record<string, unknown>;
    if (!p || typeof p !== "object") {
      throw new Error(`${filePath}: "projects[${i}]" must be an object.`);
    }
    if (typeof p.github_repository !== "string" || !p.github_repository.trim()) {
      throw new Error(`${filePath}: "projects[${i}].github_repository" must be a non-empty string.`);
    }
  }
  return raw as EnvConfig;
}

export interface ResolvedProjectDefaults {
  max_concurrency: number;
  claude_code_model: string;
  claude_describe_model: string | undefined;
  cycle_minimum_seconds: number;
  reviewers: string[];
  focus_mode: boolean;
}

/**
 * Merges per-project overrides with global defaults.
 * Per-project max_concurrency is additionally capped at the global value.
 */
export function applyProjectDefaults(
  projectConfig: ProjectEnvConfig,
  globalConfig: EnvConfig,
): ResolvedProjectDefaults {
  const globalMax = globalConfig.max_concurrency ?? 3;
  const maxConcurrency =
    projectConfig.max_concurrency !== undefined
      ? Math.min(projectConfig.max_concurrency, globalMax)
      : globalMax;
  return {
    max_concurrency: maxConcurrency,
    claude_code_model:
      projectConfig.claude_code_model ?? globalConfig.claude_code_model ?? "claude-sonnet-4-6",
    claude_describe_model:
      projectConfig.claude_describe_model ?? globalConfig.claude_describe_model,
    cycle_minimum_seconds:
      projectConfig.cycle_minimum_seconds ?? globalConfig.cycle_minimum_seconds ?? 60,
    reviewers: projectConfig.reviewers ?? [],
    focus_mode: projectConfig.focus_mode ?? false,
  };
}

/**
 * Returns the GitHub token for the given name, or the default token when no
 * name is specified. The default is the first token with `"default": true`, or
 * the first token in the array if none is marked default.
 */
export function resolveGitHubToken(envConfig: EnvConfig, tokenName?: string): string {
  if (tokenName) {
    const found = envConfig.github_tokens.find((t) => t.name === tokenName);
    if (!found) {
      throw new Error(
        `GitHub token named "${tokenName}" not found in env.json "github_tokens".`,
      );
    }
    return found.token.trim();
  }
  const defaultToken =
    envConfig.github_tokens.find((t) => t.default === true) ?? envConfig.github_tokens[0];
  if (!defaultToken) {
    throw new Error('No GitHub tokens configured in env.json "github_tokens".');
  }
  return defaultToken.token.trim();
}
