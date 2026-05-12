export interface Issue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  /**
   * GitHub's native issue Type (e.g. "Bug", "Feature", "Task"). Compared
   * case-insensitively by callers. Distinct from labels.
   */
  type: string | null;
}

/**
 * Reviewer-style inline comment posted on a specific file/line by the
 * Claude reviewer. Mirrors the shape required by the GitHub
 * "Create a review" API (`comments[]`).
 */
export interface PullRequestInlineComment {
  path: string;
  /** 1-based line number on the RIGHT (post-image) side of the diff. */
  line: number;
  body: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headSha: string;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  draft: boolean;
  hasMergeConflicts: boolean;
  /**
   * True when the most recent vibrator-posted review on the PR was
   * submitted against the current `headSha` and contained no inline
   * comments (i.e. the reviewer was satisfied). When true, the PR is
   * ready to advance to the final-description / merge phase.
   */
  hasCleanReviewOnHead: boolean;
  /** Number of unresolved review threads on the PR. */
  unresolvedReviewCommentCount: number;
  /**
   * Aggregated state of the head commit's status checks.
   *   - `"success"`: every check has completed successfully (or no
   *     checks have run).
   *   - `"failure"`: at least one check has reported `FAILURE`/`ERROR`.
   *   - `"pending"`: at least one check is still running.
   *   - `"none"`: no associated status checks. Treated as success.
   */
  checksStatus: "success" | "failure" | "pending" | "none";
  /** Issue numbers referenced as closing this PR (Closes/Fixes/Resolves). */
  closingIssueNumbers: number[];
  /** Linked issues (closing references + broader linked keywords). */
  linkedIssueNumbers: number[];
}

export type AgentSessionPhase =
  | "implementation"
  | "review"
  | "address-review-comments"
  | "address-failing-checks"
  | "resolve-conflicts"
  | "final-description"
  | "squash-merge";

export type AgentSessionStatus = "in_progress" | "completed" | "failed";

export interface AgentSessionResult {
  /** Number of inline comments posted by the Claude reviewer. */
  reviewCommentCount?: number;
  /** Final PR description produced by Claude. */
  generatedDescription?: string;
  /** PR body observed at the time of the session. */
  pullRequestBody?: string;
  /** PR head SHA observed at the time of the session. */
  pullRequestHeadSha?: string;
  /** Error message captured when the session failed. */
  errorMessage?: string;
}

export interface AgentSession {
  id: string;
  /** Issue this session is associated with (undefined for PR-only flows). */
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
      type: "review-pull-request";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
    }
  | {
      type: "address-review-comments";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
      unresolvedReviewCommentCount: number;
    }
  | {
      type: "address-failing-checks";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
    }
  | {
      type: "resolve-conflicts";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
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
      type: "squash-merge";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestTitle: string;
      closingIssueNumbers: number[];
      pullRequestBody: string;
    };

export interface OrchestratorPlan {
  actions: OrchestratorAction[];
  blockedIssueNumbers: Record<number, number[]>;
}
