export interface CylinderState {
  index: number;
  color: string;
  colorRgb: string;
  colorName: string;
  status: 'idle' | 'active' | 'done' | 'error' | 'shutdown';
  idleStatusText: string;
  actionType: string | null;
  /** "owner/repo" this cylinder is currently working, or null when idle. */
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  model: string | null;
  iterationNumber: number;
  thinkingLines: string[];
  actionStartedAt: number | null;
  nextCycleAtMs: number | null;
  rateLimitedUntilMs: number | null;
}

export interface IssueCard {
  number: number;
  title: string;
  state: string;
}

export interface PRCard {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  checksStatus?: string;
  closingIssueNumbers?: number[];
  linkedIssueNumbers?: number[];
}

export interface LifecyclePair {
  issue?: IssueCard | null;
  pr?: PRCard | null;
  prPhase: string;
  colorIndex?: number;
  blockedByIssueNumbers?: number[];
  disabled?: boolean;
  /** Project status label for inactive pills (e.g. "Backlog", "Done"). */
  projectStatus?: string;
  /** "owner/repo" this pair belongs to (set by the store from the update's scope). */
  repo?: string;
}

export interface BroadcastEventData {
  id: string;
  category: string;
  label: string;
  stateBefore: string;
  changeHow: string;
  stateAfter: string;
  excellence: string;
  workerIndex?: number;
  prNumber?: number;
  issueNumber?: number;
  commitHash?: string;
  runId?: string;
  /** "owner/repo" this feed item belongs to (shown as a chip in multi-project mode). */
  repo?: string;
  time: string;
  color: string;
}

export interface EventLine {
  text: string;
  cylinderIdx: number;
  level: string;
  time: string;
  color: string | null;
  /** "owner/repo" this log line came from, when it originates from a project. */
  repo?: string;
}

export interface DashboardState {
  connection: 'connecting' | 'connected' | 'disconnected';
  maxConcurrency: number;
  cylinders: CylinderState[];
  issueCards: Map<number, IssueCard>;
  prCards: Map<number, PRCard>;
  cylinderByIssue: Map<number, number>;
  cylinderByPR: Map<number, number>;
  /** Lifecycle pairs per project ("owner/repo" → pairs). Kept separate so the
   *  projects sharing one dashboard never clobber each other's pane. */
  lifecycleByRepo: Map<string, LifecyclePair[]>;
  /** Flattened view of lifecycleByRepo, recomputed on each lifecycle update. */
  lastLifecyclePairs: LifecyclePair[];
  /** Active session count per project; `sessionCount` is their sum. */
  sessionCountByRepo: Map<string, number>;
  broadcastQueue: BroadcastEventData[];
  broadcastVisible: BroadcastEventData[];
  eventStream: EventLine[];
  eventCount: number;
  sessionCount: number;
  shutdownRequested: boolean;
  appShutdown: boolean;
  /** True when more than one project shares this dashboard. */
  multiProject: boolean;
  owner: string;
  repo: string;
  title: string;
}
