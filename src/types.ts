export interface Issue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  assignees: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  draft: boolean;
  hasMergeConflicts: boolean;
  linkedIssueNumbers: number[];
  closingIssueNumbers: number[];
}

export type AgentSessionPhase =
  | "implementation"
  | "review"
  | "address-review-comments"
  | "resolve-conflicts"
  | "final-description";

export type AgentSessionStatus = "queued" | "in_progress" | "completed" | "failed";

export interface AgentSessionResult {
  reviewCommentCount?: number;
  generatedDescription?: string;
  pullRequestBody?: string;
  pullRequestHeadSha?: string;
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
  | {
      type: "request-review";
      issueNumber: number;
      pullRequestNumber: number;
      resolveReviewThreads?: boolean;
    }
  | {
      type: "address-review-comments";
      issueNumber: number;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
      reviewCommentCount: number;
    }
  | {
      type: "write-final-description";
      issueNumber: number;
      pullRequestNumber: number;
      closingIssueNumbers: number[];
      pullRequestBody: string;
    }
  | {
      type: "resolve-conflicts";
      issueNumber: number;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
    }
  | {
      type: "merge-pull-request";
      issueNumber: number;
      closingIssueNumbers: number[];
      pullRequestNumber: number;
      pullRequestBody: string;
    };

export interface OrchestratorPlan {
  actions: OrchestratorAction[];
  blockedIssueNumbers: Record<number, number[]>;
}
