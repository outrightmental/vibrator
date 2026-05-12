export interface Issue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  assignees: string[];
  /**
   * GitHub's native issue Type (e.g. "Bug", "Feature", "Task"). This is the
   * `type` field surfaced by the Issue Types feature — distinct from labels.
   * `null` when the repository has no type assigned to the issue (or hasn't
   * adopted issue types). Compared case-insensitively by callers.
   */
  type: string | null;
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
  /**
   * ID of the GitHub issue/PR comment vibrator posted to summon Copilot
   * (e.g. the "@copilot please address every review comment" prompt). Used
   * by the reconciler to look for a Copilot "eyes" reaction proving the
   * agent picked up the job.
   */
  promptCommentId?: number;
}

/**
 * Persistent reason captured when a session ends in `failed` because the
 * reconciler proactively gave up on it. Used by the orchestrator to adjust
 * the next retry (e.g. unassign + re-assign Copilot before re-summoning).
 */
export type AgentSessionStaleReason =
  | "issue-closed"
  | "copilot-not-assigned"
  | "copilot-review-failed"
  | "copilot-review-comments-not-addressed"
  | "copilot-did-not-acknowledge";

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
  /**
   * When `status === "failed"`, why the reconciler ended the session.
   * Persisted so subsequent planning iterations can adjust the next retry
   * (e.g. detect a `copilot-did-not-acknowledge` failure and unassign +
   * re-assign Copilot before re-summoning).
   */
  staleReason?: AgentSessionStaleReason;
}

export interface RepositorySnapshot {
  issues: Issue[];
  pullRequests: PullRequest[];
  agentSessions: AgentSession[];
}

export type OrchestratorAction =
  | {
      type: "start-implementation";
      issueNumber: number;
      /**
       * Unassign Copilot from the issue before re-assigning. Used after a
       * prior `copilot-did-not-acknowledge` failure to give the coding
       * agent a fresh assignment trigger.
       */
      reassignCopilot?: boolean;
    }
  | {
      type: "request-review";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      resolveReviewThreads?: boolean;
      /**
       * Toggle the PR draft → ready-for-review before requesting the
       * Copilot review. Used to recover from a prior Copilot review that
       * failed with "Copilot wasn't able to review any files in this pull
       * request." — GitHub's documented reset for that failure mode.
       */
      resetDraftState?: boolean;
    }
  | {
      type: "address-review-comments";
      issueNumber: number | undefined;
      pullRequestNumber: number;
      pullRequestHeadSha: string;
      reviewCommentCount: number;
      /**
       * Unassign + re-assign Copilot on the PR before posting the @copilot
       * prompt. Used after a prior `copilot-did-not-acknowledge` failure
       * to nudge the coding agent into picking up the job.
       */
      reassignCopilot?: boolean;
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
      /**
       * Unassign + re-assign Copilot on the PR before posting the @copilot
       * prompt. Used after a prior `copilot-did-not-acknowledge` failure
       * to nudge the coding agent into picking up the job.
       */
      reassignCopilot?: boolean;
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
