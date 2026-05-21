export interface CylinderState {
  index: number;
  color: string;
  colorRgb: string;
  colorName: string;
  status: 'idle' | 'active' | 'done' | 'error' | 'shutdown';
  idleStatusText: string;
  actionType: string | null;
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
  time: string;
  color: string;
}

export interface EventLine {
  text: string;
  cylinderIdx: number;
  level: string;
  time: string;
  color: string | null;
}

export interface DashboardState {
  connection: 'connecting' | 'connected' | 'disconnected';
  maxConcurrency: number;
  cylinders: CylinderState[];
  issueCards: Map<number, IssueCard>;
  prCards: Map<number, PRCard>;
  cylinderByIssue: Map<number, number>;
  cylinderByPR: Map<number, number>;
  lastLifecyclePairs: LifecyclePair[];
  broadcastQueue: BroadcastEventData[];
  broadcastVisible: BroadcastEventData[];
  eventStream: EventLine[];
  eventCount: number;
  sessionCount: number;
  shutdownRequested: boolean;
  appShutdown: boolean;
  owner: string;
  repo: string;
}
