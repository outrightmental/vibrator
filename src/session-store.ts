import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AgentSession,
  AgentSessionPhase,
  AgentSessionResult,
  AgentSessionStatus,
} from "./types.js";

interface SessionState {
  sessions: AgentSession[];
}

const MAX_PERSISTED_TERMINAL_SESSIONS = 200;
const WINDOWS_RENAME_CONFLICT_ERROR_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

function nowIsoString(): string {
  return new Date().toISOString();
}

function isActiveSession(session: AgentSession): boolean {
  return session.status === "in_progress";
}

function getSessionSortTimestamp(session: AgentSession): number {
  return Date.parse(session.updatedAt);
}

function pruneSessions(sessions: AgentSession[]): AgentSession[] {
  const activeSessions = sessions.filter(isActiveSession);
  const terminalSessions = [...sessions]
    .filter((session) => !isActiveSession(session))
    .sort((left, right) => getSessionSortTimestamp(right) - getSessionSortTimestamp(left))
    .slice(0, MAX_PERSISTED_TERMINAL_SESSIONS);

  return [...activeSessions, ...terminalSessions].sort(
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
      return { sessions: parsed.sessions ?? [] };
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
    const payload: SessionState = { sessions: pruneSessions(state.sessions) };
    await writeFile(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await replaceFileCrossPlatform(tempFilePath, this.filePath);
  }

  async load(): Promise<AgentSession[]> {
    return (await this.loadState()).sessions;
  }

  async save(sessions: AgentSession[]): Promise<void> {
    await this.writeState({ sessions });
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
    if (session.status === "completed" || session.status === "failed") {
      session.completedAt = createdAt;
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
    }
    await this.save(sessions);
    return session;
  }

  async failSession(sessionId: string): Promise<AgentSession | undefined> {
    const sessions = await this.load();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return undefined;
    }

    const failedAt = nowIsoString();
    session.status = "failed";
    session.updatedAt = failedAt;
    session.completedAt = failedAt;
    await this.save(sessions);
    return session;
  }
}
