import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { replaceFileCrossPlatform } from "./fs-utils.js";

export interface AccountState {
  /** Normalized Claude account email associated with one stored credential. */
  email: string;
  /**
   * Epoch-ms timestamp after which this account may be used again.
   * Includes the 1-minute post-reset buffer from the issue spec.
   */
  rateLimitedUntilMs?: number;
}

interface AccountStoreFile {
  nextIndex: number;
  credentials: AccountState[];
}

const RATE_LIMIT_BUFFER_MS = 60 * 1000; // 1 minute after known reset

export function defaultAccountStorePath(): string {
  return join(homedir(), ".vibrator", "claude-credential-rotation.json");
}

/**
 * Manages a pool of stored Claude credentials (accounts) and tracks
 * per-account rate-limit state with file-based persistence.
 *
 * Call `acquireAccount()` before each Claude invocation to get the currently
 * active credential email. After a rate-limit error, call `markRateLimited()`
 * with the detected reset time so that credential is skipped until it is
 * usable again.
 */
export class ClaudeAccountManager {
  private readonly accountEmails: string[];
  private readonly storePath: string;
  private nextIndex = 0;
  private states: Map<string, AccountState>;

  constructor(accountEmails: string[], storePath: string = defaultAccountStorePath()) {
    const normalized = [...new Set(accountEmails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
    if (normalized.length === 0) {
      throw new Error("ClaudeAccountManager requires at least one account email.");
    }
    this.accountEmails = normalized;
    this.storePath = storePath;
    this.states = new Map(normalized.map((email) => [email, { email }]));
  }

  /** Load persisted rate-limit state from disk, merging into the current map. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as AccountStoreFile;
      for (const saved of parsed.credentials ?? []) {
        const email = saved.email?.trim().toLowerCase();
        if (email !== undefined && this.states.has(email)) {
          const state: AccountState = { email };
          if (saved.rateLimitedUntilMs !== undefined) {
            state.rateLimitedUntilMs = saved.rateLimitedUntilMs;
          }
          this.states.set(email, state);
        }
      }
      if (typeof parsed.nextIndex === "number" && Number.isFinite(parsed.nextIndex)) {
        const size = this.accountEmails.length;
        this.nextIndex = ((Math.trunc(parsed.nextIndex) % size) + size) % size;
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
    const payload: AccountStoreFile = {
      nextIndex: this.nextIndex,
      credentials: [...this.states.values()],
    };
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await replaceFileCrossPlatform(tempPath, this.storePath);
  }

  /**
   * Returns the email of the next account available for use, or `undefined`
   * when all accounts are still rate-limited.
   */
  acquireAccount(): string | undefined {
    const now = Date.now();
    for (let offset = 0; offset < this.accountEmails.length; offset++) {
      const idx = (this.nextIndex + offset) % this.accountEmails.length;
      const email = this.accountEmails[idx]!;
      const state = this.states.get(email)!;
      if (!state.rateLimitedUntilMs || now >= state.rateLimitedUntilMs) {
        this.nextIndex = idx;
        return email;
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
   * Mark `email` as rate-limited until `resetTimeMs` + 1-minute buffer.
   * Persists state to disk automatically.
   */
  async markRateLimited(email: string, resetTimeMs: number): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const state = this.states.get(normalized);
    if (!state) return;
    state.rateLimitedUntilMs = resetTimeMs + RATE_LIMIT_BUFFER_MS;
    const currentIdx = this.accountEmails.indexOf(normalized);
    if (currentIdx >= 0 && this.nextIndex === currentIdx) {
      this.nextIndex = (currentIdx + 1) % this.accountEmails.length;
    }
    await this.save();
  }

  /** Number of configured accounts. */
  get accountCount(): number {
    return this.accountEmails.length;
  }

  /** Snapshot of current account states (for logging / dashboard). */
  getStates(): AccountState[] {
    return [...this.states.values()];
  }
}
