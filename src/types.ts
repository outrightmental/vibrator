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
  /**
   * True when the most recent Copilot coding-agent workflow run on this
   * PR's branch ended in failure AND no later successful Copilot work
   * has finished since then. Used by the orchestrator to recover a PR
   * left in a `[WIP] …` state by an aborted Copilot session (typically
   * rate-limit exhaustion) — instead of skipping the PR forever, the
   * orchestrator re-assigns Copilot to the linked issue so it can pick
   * up the existing draft PR and continue.
   */
  copilotLastAgentRunFailed: boolean;
  /**
   * Total number of files changed by this PR vs its base branch. Zero
   * means Copilot opened the draft PR (with the stock "Initial plan"
   * commit) but never managed to push any actual code changes — the
   * usual fingerprint of a Copilot session that crashed before doing
   * any work. Used by the orchestrator to abandon and restart such PRs
   * instead of leaving them stuck in `[WIP] …` state forever.
   */
  changedFiles: number;
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
  | "copilot-review-incomplete"
  | "copilot-review-comments-not-addressed"
  | "copilot-did-not-acknowledge"
  /**
   * Copilot emitted a `copilot_work_finished_failure` timeline event for
   * this session (its cloud-agent workflow run aborted, typically because
   * the user's premium-request quota was exhausted) AND made no
   * observable progress (no head SHA change, no PR body change, …)
   * before doing so. Surfacing this distinctly from
   * `copilot-did-not-acknowledge` lets the orchestrator retry instead of
   * waiting out the session-timeout, and lets the rate-limit scanner
   * decide independently whether to pause the loop.
   */
  | "copilot-stopped-with-error";

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
    }
  | {
      /**
       * Close a draft pull request that Copilot opened but never made
       * any file changes on (its cloud-agent run aborted before
       * implementing anything — typically rate-limit exhaustion). After
       * closing the PR, Copilot is unassigned and re-assigned to the
       * linked issue so it starts a fresh attempt with a clean branch.
       * Only emitted when a `[WIP] …` draft PR has 0 changed files,
       * `copilotLastAgentRunFailed`, and a linked issue.
       */
      type: "abandon-empty-pull-request";
      issueNumber: number;
      pullRequestNumber: number;
    };

export interface OrchestratorPlan {
  actions: OrchestratorAction[];
  blockedIssueNumbers: Record<number, number[]>;
}
