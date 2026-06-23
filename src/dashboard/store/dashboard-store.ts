import { CYLINDER_COLORS, CYLINDER_COLORS_RGB, CYLINDER_COLOR_NAMES } from '../shared/cylinder-palette.js';
import type { DashboardState, CylinderState, BroadcastEventData, EventLine, LifecyclePair, IssueCard, PRCard } from './types.js';
import { WsClient } from './ws-client.js';

export type { DashboardState };

// ── Wire event types (mirrors src/event-emitter.ts) ──────────────────────────

interface DashboardEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BROADCAST_FANFARE_MS = 3000;
const BROADCAST_MAX_ITEMS = 15;

function initCylinders(n: number): CylinderState[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    color: CYLINDER_COLORS[i] ?? '#888888',
    colorRgb: CYLINDER_COLORS_RGB[i] ?? '136,136,136',
    colorName: CYLINDER_COLOR_NAMES[i] ?? `CYL-${i + 1}`,
    status: 'idle' as const,
    idleStatusText: 'idle',
    actionType: null,
    issueNumber: null,
    prNumber: null,
    model: null,
    iterationNumber: 0,
    thinkingLines: [],
    actionStartedAt: null,
    nextCycleAtMs: null,
    rateLimitedUntilMs: null,
  }));
}

function makeEventLine(text: string, cylinderIdx: number, level: string): EventLine {
  const color =
    cylinderIdx >= 0 && cylinderIdx < CYLINDER_COLORS.length
      ? (CYLINDER_COLORS[cylinderIdx] ?? null)
      : null;
  return { text, cylinderIdx, level, time: new Date().toLocaleTimeString('en', { hour12: false }), color };
}

function addToStream(state: DashboardState, text: string, cylinderIdx: number, level: string): DashboardState {
  const line = makeEventLine(text, cylinderIdx, level);
  const stream = [...state.eventStream, line];
  return {
    ...state,
    eventStream: stream.length > 300 ? stream.slice(stream.length - 300) : stream,
    eventCount: state.eventCount + 1,
  };
}

function getCategoryColor(category: string, workerIndex: number | undefined): string {
  if (workerIndex !== undefined && workerIndex >= 0) {
    return CYLINDER_COLORS[workerIndex % CYLINDER_COLORS.length] ?? '#ff00ff';
  }
  const map: Record<string, string> = { commit: '#00ff88', pr: '#0088ff', ci: '#ffff00', issue: '#ff6600' };
  return map[category] ?? '#ff00ff';
}

// ── Pure reducer ──────────────────────────────────────────────────────────────

export function initialState(): DashboardState {
  return {
    connection: 'connecting',
    maxConcurrency: 3,
    cylinders: initCylinders(3),
    issueCards: new Map(),
    prCards: new Map(),
    cylinderByIssue: new Map(),
    cylinderByPR: new Map(),
    lastLifecyclePairs: [],
    broadcastQueue: [],
    broadcastVisible: [],
    eventStream: [],
    eventCount: 0,
    sessionCount: 0,
    shutdownRequested: false,
    appShutdown: false,
    owner: '',
    repo: '',
    title: '',
  };
}

export function dashboardReducer(state: DashboardState, event: DashboardEvent): DashboardState {
  switch (event.type) {
    case 'iteration-start':    return applyIterationStart(state, event.data);
    case 'action-start':       return applyActionStart(state, event.data);
    case 'action-complete':    return applyActionComplete(state, event.data);
    case 'action-error':       return applyActionError(state, event.data);
    case 'claude-thinking':    return applyClaudeThinking(state, event.data);
    case 'engine-idle':        return applyEngineIdle(state, event.data);
    case 'engine-shutdown':    return applyEngineShutdown(state, event.data);
    case 'shutdown-requested': return addToStream({ ...state, shutdownRequested: true }, '⏹ Shutdown requested — engines will stop after current cycle', -1, 'warning');
    case 'app-shutdown':       return addToStream({ ...state, appShutdown: true }, '⏹ Vibrator shutdown complete', -1, 'warning');
    case 'snapshot-update':    return applySnapshotUpdate(state, event.data);
    case 'lifecycle-update':   return applyLifecycleUpdate(state, event.data);
    case 'phase-update':       return addToStream(state, `📍 Phase: ${event.data['phase'] as string ?? ''}`, -1, 'info');
    case 'log-message':        return addToStream(state, (event.data['message'] as string) ?? '', -1, (event.data['level'] as string) ?? 'info');
    case 'workflow-approval':  return applyWorkflowApproval(state, event.data);
    case 'github-rate-limit': {
      const msg = (event.data['message'] as string) || 'rate limited';
      return addToStream(state, `⚠ GitHub rate limited: ${msg}`, -1, 'warning');
    }
    case 'github-rate-limit-cleared':
      return addToStream(state, '✓ GitHub rate limit cleared', -1, 'success');
    case 'broadcast-github-activity':
    case 'broadcast-commit':
    case 'broadcast-pr-update':
    case 'broadcast-ci-status':
    case 'broadcast-review-comment':
    case 'broadcast-issue-update':
      return applyBroadcastEvent(state, event);
    default:
      return addToStream(state, `[EVENT] ${event.type}`, -1, 'info');
  }
}

function applyIterationStart(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const engineIndex = typeof data['engineIndex'] === 'number' ? data['engineIndex'] : 0;
  const iterationNumber = typeof data['iterationNumber'] === 'number' ? data['iterationNumber'] : 0;
  const n = typeof data['maxConcurrency'] === 'number' ? data['maxConcurrency'] : state.maxConcurrency;

  let cylinders = state.cylinders;
  let cylinderByIssue = state.cylinderByIssue;
  let cylinderByPR = state.cylinderByPR;

  if (n !== state.maxConcurrency) {
    cylinders = initCylinders(n);
    cylinderByIssue = new Map();
    cylinderByPR = new Map();
  }

  const cyl = cylinders[engineIndex];
  if (cyl) {
    cylinderByIssue = new Map(cylinderByIssue);
    cylinderByPR = new Map(cylinderByPR);
    if (cyl.issueNumber !== null && cylinderByIssue.get(cyl.issueNumber) === engineIndex) {
      cylinderByIssue.delete(cyl.issueNumber);
    }
    if (cyl.prNumber !== null && cylinderByPR.get(cyl.prNumber) === engineIndex) {
      cylinderByPR.delete(cyl.prNumber);
    }
    cylinders = [...cylinders];
    cylinders[engineIndex] = {
      ...cyl,
      iterationNumber,
      status: 'idle',
      issueNumber: null,
      prNumber: null,
      actionType: null,
      idleStatusText: 'idle',
      thinkingLines: [],
      actionStartedAt: null,
      nextCycleAtMs: null,
      rateLimitedUntilMs: null,
    };
  }

  return addToStream(
    { ...state, cylinders, cylinderByIssue, cylinderByPR, maxConcurrency: n },
    `🔄 Engine ${engineIndex + 1} · cycle ${iterationNumber}`,
    engineIndex, 'info'
  );
}

function applyActionStart(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const idx = ((data['actionIndex'] as number) || 1) - 1;

  let cylinders = state.cylinders;
  let cylinderByIssue = state.cylinderByIssue;
  let cylinderByPR = state.cylinderByPR;
  const cyl = cylinders[idx];
  if (cyl) {
    cylinderByIssue = new Map(cylinderByIssue);
    cylinderByPR = new Map(cylinderByPR);
    if (cyl.issueNumber !== null && cylinderByIssue.get(cyl.issueNumber) === idx) cylinderByIssue.delete(cyl.issueNumber);
    if (cyl.prNumber !== null && cylinderByPR.get(cyl.prNumber) === idx) cylinderByPR.delete(cyl.prNumber);

    const issueNumber = (data['issueNumber'] as number | undefined) ?? null;
    const prNumber = (data['pullRequestNumber'] as number | undefined) ?? null;
    if (issueNumber !== null) cylinderByIssue.set(issueNumber, idx);
    if (prNumber !== null) cylinderByPR.set(prNumber, idx);

    cylinders = [...cylinders];
    cylinders[idx] = {
      ...cyl,
      status: 'active',
      actionType: (data['type'] as string) ?? null,
      idleStatusText: '',
      issueNumber,
      prNumber,
      model: (data['model'] as string) ?? null,
      thinkingLines: [],
      actionStartedAt: typeof data['startedAt'] === 'number' ? data['startedAt'] : Date.now(),
      nextCycleAtMs: null,
      rateLimitedUntilMs: null,
    };
  }

  const actionDesc = (data['description'] as string) || (data['type'] as string) || 'action';
  return addToStream(
    { ...state, cylinders, cylinderByIssue, cylinderByPR },
    `▶ [${data['actionIndex'] as number}/${data['totalActions'] as number}] ${actionDesc}`,
    idx, 'info'
  );
}

function applyActionComplete(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const idx = ((data['actionIndex'] as number) || 1) - 1;
  let cylinders = state.cylinders;
  const cyl = cylinders[idx];
  if (cyl) {
    cylinders = [...cylinders];
    cylinders[idx] = { ...cyl, status: 'done', thinkingLines: [] };
  }
  return addToStream({ ...state, cylinders }, `✓ action [${data['actionIndex']}/${data['totalActions']}] complete`, idx, 'success');
}

function applyActionError(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const idx = ((data['actionIndex'] as number) || 1) - 1;
  let cylinders = state.cylinders;
  const cyl = cylinders[idx];
  if (cyl) {
    cylinders = [...cylinders];
    cylinders[idx] = { ...cyl, status: 'error', thinkingLines: [] };
  }
  return addToStream({ ...state, cylinders }, `✗ action [${data['actionIndex']}/${data['totalActions']}] failed: ${data['error'] ?? ''}`, idx, 'error');
}

function applyClaudeThinking(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const engineIndex = data['engineIndex'] as number;
  const excerpt = (data['excerpt'] as string) ?? '';
  const cyl = state.cylinders[engineIndex];
  if (cyl === undefined) return state;

  const newLines = excerpt.split('\n').filter(l => l.trim().length > 0);
  let thinkingLines = [...(cyl.thinkingLines), ...newLines];
  if (thinkingLines.length > 200) thinkingLines = thinkingLines.slice(-200);

  const cylinders = [...state.cylinders];
  cylinders[engineIndex] = { ...cyl, thinkingLines };
  return { ...state, cylinders };
}

function applyEngineIdle(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const engineIndex = data['engineIndex'] as number;
  const cyl = state.cylinders[engineIndex];
  if (cyl === undefined) return state;

  const cylinderByIssue = new Map(state.cylinderByIssue);
  const cylinderByPR = new Map(state.cylinderByPR);
  if (cyl.issueNumber !== null && cylinderByIssue.get(cyl.issueNumber) === engineIndex) cylinderByIssue.delete(cyl.issueNumber);
  if (cyl.prNumber !== null && cylinderByPR.get(cyl.prNumber) === engineIndex) cylinderByPR.delete(cyl.prNumber);

  const reason = typeof data['reason'] === 'string' ? data['reason'] : '';
  const nextCycleAtMs = typeof data['nextCycleAtMs'] === 'number' ? data['nextCycleAtMs'] : null;
  const rateLimitedUntilMs = typeof data['rateLimitedUntilMs'] === 'number' ? data['rateLimitedUntilMs'] : null;

  const cylinders = [...state.cylinders];
  cylinders[engineIndex] = {
    ...cyl,
    status: 'idle',
    issueNumber: null,
    prNumber: null,
    actionType: null,
    actionStartedAt: null,
    thinkingLines: [],
    idleStatusText: reason || 'idle',
    nextCycleAtMs,
    rateLimitedUntilMs,
  };
  return { ...state, cylinders, cylinderByIssue, cylinderByPR };
}

function applyEngineShutdown(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const engineIndex = data['engineIndex'] as number;
  const cyl = state.cylinders[engineIndex];
  let cylinders = state.cylinders;
  if (cyl !== undefined) {
    cylinders = [...cylinders];
    cylinders[engineIndex] = { ...cyl, status: 'shutdown', thinkingLines: [] };
  }
  return addToStream({ ...state, cylinders }, `⏹ Engine ${(engineIndex ?? 0) + 1} shut down`, engineIndex >= 0 ? engineIndex : -1, 'warning');
}

function applySnapshotUpdate(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const issueCards = new Map<number, IssueCard>();
  const prCards = new Map<number, PRCard>();
  const sessionCount = (data['sessionCount'] as number) ?? 0;

  if (Array.isArray(data['issues'])) {
    for (const issue of data['issues'] as IssueCard[]) issueCards.set(issue.number, issue);
  }
  if (Array.isArray(data['pullRequests'])) {
    for (const pr of data['pullRequests'] as PRCard[]) prCards.set(pr.number, pr);
  }

  const newState = addToStream(
    { ...state, issueCards, prCards, sessionCount },
    `📊 Snapshot: ${data['issueCount'] ?? 0} issues, ${data['prCount'] ?? 0} PRs, ${sessionCount} sessions`,
    -1, 'info'
  );
  return newState;
}

function applyLifecycleUpdate(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const pairs = Array.isArray(data['pairs']) ? (data['pairs'] as LifecyclePair[]) : [];
  return { ...state, lastLifecyclePairs: pairs };
}

function applyBroadcastEvent(state: DashboardState, event: DashboardEvent): DashboardState {
  const data = event.data;
  const category =
    event.type === 'broadcast-ci-status' ? 'ci' :
    event.type === 'broadcast-commit' ? 'commit' :
    event.type === 'broadcast-pr-update' ? 'pr' :
    event.type === 'broadcast-issue-update' ? 'issue' : 'info';

  const label = event.type.replace('broadcast-', '').replace(/-/g, ' ').toUpperCase();
  let workerIndex = (data['workerIndex'] as number | undefined);
  if (workerIndex === undefined) {
    const prNum = data['prNumber'] as number | undefined;
    const issueNum = data['issueNumber'] as number | undefined;
    if (prNum !== undefined) workerIndex = state.cylinderByPR.get(prNum);
    if (issueNum !== undefined && workerIndex === undefined) workerIndex = state.cylinderByIssue.get(issueNum);
  }

  const color = getCategoryColor(category, workerIndex);
  const prNumber = data['prNumber'] as number | undefined;
  const issueNumber = data['issueNumber'] as number | undefined;
  const commitHash = data['hash'] as string | undefined;
  const item: BroadcastEventData = {
    id: `${Date.now()}-${Math.random()}`,
    category,
    label,
    stateBefore: (data['stateBefore'] as string) || (data['content'] as string) || '',
    changeHow: (data['changeHow'] as string) || '',
    stateAfter: (data['stateAfter'] as string) || '',
    excellence: (data['excellence'] as string) || '',
    ...(workerIndex !== undefined ? { workerIndex } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(commitHash !== undefined ? { commitHash } : {}),
    time: new Date().toLocaleTimeString(),
    color,
  };

  return { ...state, broadcastQueue: [...state.broadcastQueue, item] };
}

function applyWorkflowApproval(state: DashboardState, data: Record<string, unknown>): DashboardState {
  const runName = (data['runName'] as string) || 'unknown';
  const color = getCategoryColor('ci', undefined);
  const runIdVal = data['runId'] as string | undefined;
  const item: BroadcastEventData = {
    id: `${Date.now()}-${Math.random()}`,
    category: 'ci',
    label: 'WORKFLOW',
    stateBefore: `Workflow "${runName}" was awaiting approval`,
    changeHow: 'Vibrator automatically approved the workflow run',
    stateAfter: `✅ Workflow "${runName}" approved and queued`,
    excellence: 'CI pipeline unblocked — automated approval keeps development flowing',
    ...(runIdVal !== undefined ? { runId: runIdVal } : {}),
    time: new Date().toLocaleTimeString(),
    color,
  };
  return { ...state, broadcastQueue: [...state.broadcastQueue, item] };
}

// ── Store class ───────────────────────────────────────────────────────────────

type Listener = (state: DashboardState) => void;

export class DashboardStore {
  private _state: DashboardState;
  private _listeners: Set<Listener> = new Set();
  private _broadcastProcessing = false;
  private _wsClient: WsClient | null = null;

  constructor() {
    this._state = initialState();
    setInterval(() => this._notify(), 1000);
  }

  getState(): DashboardState { return this._state; }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _notify() {
    for (const l of this._listeners) l(this._state);
  }

  private _setState(state: DashboardState) {
    this._state = state;
    this._notify();
  }

  applyEvent(event: DashboardEvent) {
    this._setState(dashboardReducer(this._state, event));
    this._drainBroadcastQueue();
  }

  private _drainBroadcastQueue() {
    if (this._broadcastProcessing) return;
    if (this._state.broadcastQueue.length === 0) return;
    this._broadcastProcessing = true;

    const [head, ...rest] = this._state.broadcastQueue;
    const visible = [head!, ...this._state.broadcastVisible].slice(0, BROADCAST_MAX_ITEMS);
    this._setState({ ...this._state, broadcastQueue: rest, broadcastVisible: visible });

    setTimeout(() => {
      this._broadcastProcessing = false;
      this._drainBroadcastQueue();
    }, BROADCAST_FANFARE_MS);
  }

  async bootstrap(): Promise<void> {
    try {
      const res = await fetch('/api/state');
      const data = await res.json() as {
        owner?: string;
        repo?: string;
        dashboardTitle?: string;
        maxConcurrency?: number;
        cachedEvents?: DashboardEvent[];
      };

      let state = initialState();
      state.owner = data.owner ?? '';
      state.repo = data.repo ?? '';
      state.title = data.dashboardTitle ?? data.repo ?? '';
      if (typeof data.maxConcurrency === 'number') {
        state.maxConcurrency = data.maxConcurrency;
        state.cylinders = initCylinders(data.maxConcurrency);
      }
      for (const event of (data.cachedEvents ?? [])) {
        state = dashboardReducer(state, event);
      }
      this._setState(state);
    } catch (err) {
      console.error('[DashboardStore] bootstrap failed:', err);
    }
  }

  connectLive(): void {
    const client = new WsClient(
      `ws://${location.host}/api/ws`,
      (event) => this.applyEvent(event),
      async () => {
        await this.bootstrap();
      },
      (connected) => {
        this._setState({ ...this._state, connection: connected ? 'connected' : 'disconnected' });
      }
    );
    this._wsClient = client;
    client.connect();
  }
}
