import type { AgentSession, AgentSessionResult } from "./types.js";

export interface ReconcileSessionStore {
  failSession(sessionId: string): Promise<AgentSession | undefined>;
}

export interface ReconcileSessionEvent {
  session: AgentSession;
  outcome: "failed-stale";
}

/**
 * Since every Claude action runs synchronously, an `in_progress` session
 * observed at the start of a new iteration can only be the carcass of a
 * previous vibrator process that crashed mid-action. Fail it so a fresh
 * planning iteration can re-plan.
 */
export async function reconcileSessions(
  sessionStore: ReconcileSessionStore,
  agentSessions: ReadonlyArray<AgentSession>,
): Promise<ReconcileSessionEvent[]> {
  const events: ReconcileSessionEvent[] = [];
  for (const session of agentSessions) {
    if (session.status !== "in_progress") continue;
    await sessionStore.failSession(session.id);
    events.push({ session, outcome: "failed-stale" });
  }
  return events;
}

// Re-exported so call sites that previously imported AgentSessionResult
// from this module keep compiling. Trivial type re-export only.
export type { AgentSessionResult };
