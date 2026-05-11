import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AgentSession,
  AgentSessionPhase,
  AgentSessionResult,
  AgentSessionStaleReason,
  AgentSessionStatus,
} from "./types.js";

interface SessionState {
  sessions: AgentSession[];
  /**
   * ISO-8601 timestamp until which the orchestrator should pause all
   * GitHub-side actions because Copilot has reported a rate-limit
   * exhaustion. `undefined` (or a past timestamp) means "not paused".
   * Stored alongside sessions so the pause survives process restarts —
   * the whole point of the feature is to avoid spamming the repo with
   * requests across iterations.
   */
  rateLimitedUntil?: string;
}

// Keep enough recent terminal history for follow-up planning while preventing
// the local session-store file from growing without bound during long-running use.
const MAX_PERSISTED_TERMINAL_SESSIONS = 200;
const WINDOWS_RENAME_CONFLICT_ERROR_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

function nowIsoString(): string {
  return new Date().toISOString();
}

function isActiveSession(session: AgentSession): boolean {
  return session.status === "queued" || session.status === "in_progress";
}

function getSessionSortTimestamp(session: AgentSession): number {
  return Date.parse(session.updatedAt);
}

function buildSessionKey(session: AgentSession): string {
  return `${session.issueNumber ?? ""}:${session.pullRequestNumber ?? ""}:${session.phase}`;
}

function pruneSessions(sessions: AgentSession[]): AgentSession[] {
  const activeSessions = sessions.filter(isActiveSession);
  const terminalSessionsByKey = new Map<string, AgentSession>();

  for (const session of [...sessions]
    .filter((session) => !isActiveSession(session))
    .sort((left, right) => getSessionSortTimestamp(right) - getSessionSortTimestamp(left))) {
    const key = buildSessionKey(session);
    if (!terminalSessionsByKey.has(key)) {
      terminalSessionsByKey.set(key, session);
    }
    if (terminalSessionsByKey.size >= MAX_PERSISTED_TERMINAL_SESSIONS) {
      break;
    }
  }

  return [...activeSessions, ...terminalSessionsByKey.values()].sort(
    (left, right) => getSessionSortTimestamp(left) - getSessionSortTimestamp(right),
  );
}

async function replaceFileCrossPlatform(
  tempFilePath: string,
  filePath: string,
): Promise<void> {
  try {
    await rename(tempFilePath, filePath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !WINDOWS_RENAME_CONFLICT_ERROR_CODES.has(code)) {
      throw error;
    }
  }

  const backupFilePath = `${filePath}.${randomUUID()}.bak`;
  let backupCreated = false;

  try {
    try {
      await rename(filePath, backupFilePath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await rename(tempFilePath, filePath);
  } catch (error) {
    if (backupCreated) {
      try {
        await rename(backupFilePath, filePath);
      } catch {
        // Best effort restore before surfacing the original write failure.
      }
    }

    await rm(tempFilePath, { force: true });
    throw error;
  }

  if (backupCreated) {
    try {
      await rm(backupFilePath, { force: true });
    } catch {
      // Best-effort cleanup after the replacement already succeeded.
    }
  }
}

export class FileSessionStore {
  constructor(private readonly filePath: string) {}

  private async loadState(): Promise<SessionState> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as SessionState;
      return {
        sessions: parsed.sessions ?? [],
        ...(parsed.rateLimitedUntil !== undefined
          ? { rateLimitedUntil: parsed.rateLimitedUntil }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [] };
      }

      throw error;
    }
  }

  private async writeState(state: SessionState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.${randomUUID()}.tmp`;
    const payload: SessionState = {
      sessions: pruneSessions(state.sessions),
      ...(state.rateLimitedUntil !== undefined
        ? { rateLimitedUntil: state.rateLimitedUntil }
        : {}),
    };
    await writeFile(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await replaceFileCrossPlatform(tempFilePath, this.filePath);
  }

  async load(): Promise<AgentSession[]> {
    return (await this.loadState()).sessions;
  }

  async save(sessions: AgentSession[]): Promise<void> {
    const previous = await this.loadState();
    const next: SessionState = { sessions };
    if (previous.rateLimitedUntil !== undefined) {
      next.rateLimitedUntil = previous.rateLimitedUntil;
    }
    await this.writeState(next);
  }

  /**
   * Returns the rate-limit pause expiry, or `undefined` when not paused.
   * The orchestrator must skip all GitHub-side actions while the
   * returned timestamp is in the future.
   */
  async getRateLimitedUntil(): Promise<Date | undefined> {
    const state = await this.loadState();
    if (state.rateLimitedUntil === undefined) {
      return undefined;
    }
    const parsed = Date.parse(state.rateLimitedUntil);
    return Number.isNaN(parsed) ? undefined : new Date(parsed);
  }

  /**
   * Sets (or clears, when `until` is `undefined`) the rate-limit pause
   * expiry. Existing sessions are preserved untouched.
   */
  async setRateLimitedUntil(until: Date | undefined): Promise<void> {
    const state = await this.loadState();
    if (until === undefined) {
      delete state.rateLimitedUntil;
    } else {
      state.rateLimitedUntil = until.toISOString();
    }
    await this.writeState(state);
  }

  async createSession(input: {
    issueNumber?: number | undefined;
    pullRequestNumber?: number;
    phase: AgentSessionPhase;
    status?: AgentSessionStatus;
    result?: AgentSessionResult;
  }): Promise<AgentSession> {
    const sessions = await this.load();
    const createdAt = nowIsoString();
    const session: AgentSession = {
      id: randomUUID(),
      issueNumber: input.issueNumber,
      phase: input.phase,
      status: input.status ?? "in_progress",
      createdAt,
      updatedAt: createdAt,
    };
    if (input.pullRequestNumber !== undefined) {
      session.pullRequestNumber = input.pullRequestNumber;
    }
    if (input.result !== undefined) {
      session.result = input.result;
    }
    sessions.push(session);
    await this.save(sessions);
    return session;
  }

  async completeSession(
    sessionId: string,
    result?: AgentSessionResult,
  ): Promise<AgentSession | undefined> {
    const sessions = await this.load();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return undefined;
    }

    const completedAt = nowIsoString();
    session.status = "completed";
    session.updatedAt = completedAt;
    session.completedAt = completedAt;
    if (result !== undefined) {
      session.result = result;
    } else {
      delete session.result;
    }
    await this.save(sessions);
    return session;
  }

  async failSession(
    sessionId: string,
    options: { staleReason?: AgentSessionStaleReason } = {},
  ): Promise<AgentSession | undefined> {
    const sessions = await this.load();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return undefined;
    }

    const failedAt = nowIsoString();
    session.status = "failed";
    session.updatedAt = failedAt;
    session.completedAt = failedAt;
    if (options.staleReason !== undefined) {
      session.staleReason = options.staleReason;
    }
    await this.save(sessions);
    return session;
  }

  async failStaleSessions(maxAgeMs: number, now = Date.now()): Promise<AgentSession[]> {
    const sessions = await this.load();
    const failedSessions: AgentSession[] = [];
    const failedAt = new Date(now).toISOString();

    for (const session of sessions) {
      if (!isActiveSession(session)) {
        continue;
      }

      const lastUpdatedAt = Date.parse(session.updatedAt);
      if (Number.isNaN(lastUpdatedAt) || now - lastUpdatedAt < maxAgeMs) {
        continue;
      }

      session.status = "failed";
      session.updatedAt = failedAt;
      session.completedAt = failedAt;
      failedSessions.push(session);
    }

    if (failedSessions.length > 0) {
      await this.save(sessions);
    }

    return failedSessions;
  }
}
