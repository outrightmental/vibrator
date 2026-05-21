export interface Commit {
  hash: string;
  author: string;
  message: string;
  pushedAt: string;
}

export interface Milestone {
  /** GitHub milestone number, used to order the work queue across milestones. */
  number: number;
  title: string;
}

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
  /**
   * Issue number of the parent issue when this issue is a sub-issue.
   * Undefined for top-level issues.
   */
  parentNumber?: number;
  /**
   * Issue numbers blocking this issue, sourced from GitHub's native
   * Issue Dependencies feature (the "blocked by" relationship configured
   * via the GitHub UI / API, distinct from body-text mentions and from
   * sub-issue parent/child links). Empty or undefined when the feature
   * is unused, unavailable, or returned an empty list.
   */
  blockedByIssueNumbers?: number[];
  /**
   * The milestone this issue belongs to, if any. Milestones order the work
   * queue — issues from earlier-numbered milestones are picked first — but do
   * not gate it: an issue from any milestone is eligible to start.
   */
  milestone?: Milestone;
  /** Label names applied to this issue. */
  labels: string[];
  /**
   * The issue's status in the GitHub Project (e.g. "Ready", "In Progress",
   * "In Review"). Only populated when project mode is active.
   */
  projectStatus?: string;
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
  /**
   * ISO timestamp of when the head commit was pushed, used to detect
   * checks that have been pending for too long.
   */
  headCommitPushedAt: string | undefined;
  /** Label names applied to this PR. */
  labels: string[];
  /** Issue numbers referenced as closing this PR (Closes/Fixes/Resolves). */
  closingIssueNumbers: number[];
  /** Linked issues (closing references + broader linked keywords). */
  linkedIssueNumbers: number[];
  /**
   * True when there are human PR comments newer than the last comment
   * vibrator processed. Only set (true) in project mode when the latest
   * completed session for this PR is `request-review`.
   */
  hasNewCommentsSinceLastRead?: boolean;
}

export type AgentSessionPhase =
  | "implementation"
  | "self-review"
  | "address-failing-checks"
  | "resolve-conflicts"
  | "squash-merge"
  | "request-review";

export type AgentSessionStatus = "in_progress" | "completed" | "failed";

export interface AgentSessionResult {
  /** PR body observed at the time of the session. */
  pullRequestBody?: string;
  /** PR head SHA observed at the time of the session. */
  pullRequestHeadSha?: string;
  /** Error message captured when the session failed. */
  errorMessage?: string;
  /**
   * True when a branch-modifying phase (address-failing-checks,
   * resolve-conflicts) completed but pushed no new commits — the branch
   * HEAD SHA was unchanged.
   */
  noCommitsPushed?: boolean;
  /**
   * True when a self-review session committed and pushed changes to the
   * branch. False when the review found nothing to change.
   */
  madeChanges?: boolean;
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
      type: "self-review";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
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
      type: "squash-merge";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestTitle: string;
      pullRequestHeadRefName: string;
      closingIssueNumbers: number[];
      pullRequestBody: string;
    }
  | {
      type: "request-review";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      /** Human reviewer logins to request review from. */
      reviewers: string[];
    };

export interface OrchestratorPlan {
  actions: OrchestratorAction[];
  blockedIssueNumbers: Record<number, number[]>;
}
