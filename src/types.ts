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
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  draft: boolean;
  hasMergeConflicts: boolean;
  /**
   * True when the Copilot pull-request review bot has submitted a review on
   * the current head SHA that requested no changes and contains no review
   * comments. Once true, the PR is considered ready to merge and the
   * orchestrator must not request another review.
   */
  hasCleanCopilotReviewOnHead: boolean;
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
  /**
   * The issue this session is associated with, when one exists. PR-only
   * shepherding flows (review/merge of a PR with no linked issue) leave
   * this undefined.
   */
  issueNumber: number | undefined;
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
      issueNumber: number | undefined;
      pullRequestNumber: number;
      resolveReviewThreads?: boolean;
    }
  | {
      type: "address-review-comments";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
      reviewCommentCount: number;
    }
  | {
      type: "write-final-description";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestTitle: string;
      pullRequestHeadRefName: string;
      closingIssueNumbers: number[];
      pullRequestBody: string;
    }
  | {
      type: "resolve-conflicts";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
    }
  | {
      type: "merge-pull-request";
      issueNumber: number | undefined;
      closingIssueNumbers: number[];
      pullRequestNumber: number;
      pullRequestBody: string;
    };

export interface OrchestratorPlan {
  actions: OrchestratorAction[];
  blockedIssueNumbers: Record<number, number[]>;
}
