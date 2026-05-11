import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentSession, AgentSessionPhase, AgentSessionResult, AgentSessionStatus } from "./types.js";

interface SessionState {
  sessions: AgentSession[];
}

function nowIsoString(): string {
  return new Date().toISOString();
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
    await writeFile(
      this.filePath,
      `${JSON.stringify({ sessions }, null, 2)}\n`,
      "utf8",
    );
  }

  async createSession(input: {
    issueNumber: number;
    pullRequestNumber?: number;
    phase: AgentSessionPhase;
    status?: AgentSessionStatus;
  }): Promise<AgentSession> {
    const sessions = await this.load();
    const createdAt = nowIsoString();
    const session: AgentSession = {
      id: `${input.phase}-${input.issueNumber}-${Date.now()}`,
      issueNumber: input.issueNumber,
      phase: input.phase,
      status: input.status ?? "in_progress",
      createdAt,
      updatedAt: createdAt,
    };
    if (input.pullRequestNumber !== undefined) {
      session.pullRequestNumber = input.pullRequestNumber;
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
}
