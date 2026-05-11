export interface Issue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  draft: boolean;
  linkedIssueNumbers: number[];
}

export type AgentSessionPhase =
  | "implementation"
  | "review"
  | "address-review-comments"
  | "final-description";

export type AgentSessionStatus = "queued" | "in_progress" | "completed" | "failed";

export interface AgentSessionResult {
  reviewCommentCount?: number;
  generatedDescription?: string;
}

export interface AgentSession {
  id: string;
  issueNumber: number;
  pullRequestNumber?: number;
  phase: AgentSessionPhase;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: AgentSessionResult;
}

export interface RepositorySnapshot {
  issues: Issue[];
  pullRequests: PullRequest[];
  agentSessions: AgentSession[];
}

export type OrchestratorAction =
  | { type: "start-implementation"; issueNumber: number }
  | { type: "request-review"; issueNumber: number; pullRequestNumber: number }
  | {
      type: "address-review-comments";
      issueNumber: number;
      pullRequestNumber: number;
      reviewCommentCount: number;
    }
  | { type: "write-final-description"; issueNumber: number; pullRequestNumber: number }
  | {
      type: "merge-pull-request";
      issueNumber: number;
      issueNumbers: number[];
      pullRequestNumber: number;
      pullRequestBody: string;
    };

export interface OrchestratorPlan {
  actions: OrchestratorAction[];
  blockedIssueNumbers: Record<number, number[]>;
}
