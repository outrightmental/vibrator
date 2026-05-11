import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentSession, AgentSessionPhase, AgentSessionResult, AgentSessionStatus } from "./types.js";

interface SessionState {
  sessions: AgentSession[];
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
  return `${session.issueNumber}:${session.pullRequestNumber ?? ""}:${session.phase}`;
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

  async load(): Promise<AgentSession[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as SessionState;
      return parsed.sessions ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async save(sessions: AgentSession[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(
      tempFilePath,
      `${JSON.stringify({ sessions: pruneSessions(sessions) }, null, 2)}\n`,
      "utf8",
    );
    await replaceFileCrossPlatform(tempFilePath, this.filePath);
  }

  async createSession(input: {
    issueNumber: number;
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
