import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { replaceFileCrossPlatform } from "./fs-utils.js";

export interface AccountState {
  /** Path to the Claude config directory for this account (e.g. ~/.claude-account1). */
  configDir: string;
  /**
   * Epoch-ms timestamp after which this account may be used again.
   * Includes the 1-minute post-reset buffer from the issue spec.
   */
  rateLimitedUntilMs?: number;
}

interface AccountStoreFile {
  accounts: AccountState[];
}

const RATE_LIMIT_BUFFER_MS = 60 * 1000; // 1 minute after known reset

export function defaultAccountStorePath(): string {
  return join(homedir(), ".vibrator", "claude-accounts.json");
}

/**
 * Parses the CLAUDE_ACCOUNTS environment variable value into a list of
 * config-directory paths. Accepts newline- or comma-separated entries and
 * ignores blank lines and leading/trailing whitespace.
 */
export function parseClaudeAccountsEnv(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Manages a pool of Claude Code config directories (accounts) and tracks
 * per-account rate-limit state with file-based persistence.
 *
 * When CLAUDE_ACCOUNTS is configured, call `acquireAccount()` before each
 * Claude invocation to obtain the `configDir` to pass as `CLAUDE_HOME` in the
 * subprocess environment. After a rate-limit error, call `markRateLimited()`
 * with the detected reset time so the account is skipped until it's usable.
 */
export class ClaudeAccountManager {
  private readonly configDirs: string[];
  private readonly storePath: string;
  private states: Map<string, AccountState>;

  constructor(configDirs: string[], storePath: string = defaultAccountStorePath()) {
    if (configDirs.length === 0) {
      throw new Error("ClaudeAccountManager requires at least one config directory.");
    }
    this.configDirs = configDirs;
    this.storePath = storePath;
    this.states = new Map(configDirs.map((d) => [d, { configDir: d }]));
  }

  /** Load persisted rate-limit state from disk, merging into the current map. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as AccountStoreFile;
      for (const saved of parsed.accounts ?? []) {
        if (this.states.has(saved.configDir)) {
          const state: AccountState = { configDir: saved.configDir };
          if (saved.rateLimitedUntilMs !== undefined) {
            state.rateLimitedUntilMs = saved.rateLimitedUntilMs;
          }
          this.states.set(saved.configDir, state);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // No store file yet — start with clean state.
    }
  }

  /** Persist current rate-limit state to disk. */
  async save(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${randomUUID()}.tmp`;
    const payload: AccountStoreFile = { accounts: [...this.states.values()] };
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await replaceFileCrossPlatform(tempPath, this.storePath);
  }

  /**
   * Returns the config directory of the next account available for use, or
   * `undefined` when all accounts are still rate-limited.  Call `save()` after
   * `markRateLimited()` to persist state changes.
   */
  acquireAccount(): string | undefined {
    const now = Date.now();
    for (const configDir of this.configDirs) {
      const state = this.states.get(configDir)!;
      if (!state.rateLimitedUntilMs || now >= state.rateLimitedUntilMs) {
        return configDir;
      }
    }
    return undefined;
  }

  /**
   * Returns the epoch-ms timestamp when the earliest rate-limited account
   * becomes available again, or `undefined` if at least one account is
   * available right now.
   */
  earliestAvailableMs(): number | undefined {
    if (this.acquireAccount() !== undefined) return undefined;
    let earliest: number | undefined;
    for (const state of this.states.values()) {
      if (state.rateLimitedUntilMs !== undefined) {
        earliest =
          earliest === undefined ? state.rateLimitedUntilMs : Math.min(earliest, state.rateLimitedUntilMs);
      }
    }
    return earliest;
  }

  /**
   * Mark `configDir` as rate-limited until `resetTimeMs` + 1-minute buffer.
   * Persists state to disk automatically.
   */
  async markRateLimited(configDir: string, resetTimeMs: number): Promise<void> {
    const state = this.states.get(configDir);
    if (!state) return;
    state.rateLimitedUntilMs = resetTimeMs + RATE_LIMIT_BUFFER_MS;
    await this.save();
  }

  /** Number of configured accounts. */
  get accountCount(): number {
    return this.configDirs.length;
  }

  /** Snapshot of current account states (for logging / dashboard). */
  getStates(): AccountState[] {
    return [...this.states.values()];
  }
}
