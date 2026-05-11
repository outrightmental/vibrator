import { spawn } from "node:child_process";
import { join } from "node:path";

import { parseClosingIssueNumbers, parseLinkedIssueNumbers } from "./orchestrator.js";
import { FileSessionStore } from "./session-store.js";
import type { AgentSession, Issue, PullRequest, RepositorySnapshot } from "./types.js";

/**
 * Runs a shell command, inheriting stderr (so any failure output is visible)
 * and rejecting on a non-zero exit code.
 */
function runShellCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Command \`${command} ${args.join(" ")}\` exited with non-zero status ${code ?? "unknown"}.`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

function mergeSortedUnique(...sources: ReadonlyArray<readonly number[]>): number[] {
  const merged = new Set<number>();
  for (const source of sources) {
    for (const value of source) {
      merged.add(value);
    }
  }
  return [...merged].sort((left, right) => left - right);
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  pull_request?: object;
  assignees?: Array<{ login: string }> | null;
}

interface GitHubPullRequestResponse {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string; ref: string };
  state: "open" | "closed";
  draft: boolean;
  created_at: string;
  updated_at: string;
}

interface GitHubPullRequestReviewResponse {
  submitted_at: string | null;
  user: { login: string } | null;
  state: string;
  body: string | null;
}

/**
 * Login of the GitHub Copilot pull-request review bot.
 */
export const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer";

/**
 * Pattern matching the failure message Copilot posts as a review body when
 * it could not analyze the PR (e.g. "Copilot wasn't able to review any files
 * in this pull request."). A review matching this body must NEVER be
 * treated as a successful approval.
 */
export const COPILOT_REVIEW_FAILURE_PATTERN = /wasn't able to review/i;

/**
 * Pattern matching the success message Copilot posts when it has reviewed
 * the PR and found nothing worth commenting on (e.g. "Copilot reviewed N
 * files... and generated no comments."). Only reviews matching this body
 * (or an explicit APPROVED state) are accepted as a clean review that
 * authorizes squash-and-merge.
 */
export const COPILOT_REVIEW_SUCCESS_PATTERN = /generated no comments/i;

export function isFailedCopilotReview(review: {
  authorLogin?: string | undefined;
  body?: string | null | undefined;
}): boolean {
  if (review.authorLogin?.toLowerCase() !== COPILOT_REVIEWER_LOGIN) {
    return false;
  }
  return COPILOT_REVIEW_FAILURE_PATTERN.test(review.body ?? "");
}

export function isCleanCopilotReview(review: {
  authorLogin?: string | undefined;
  state?: string | undefined;
  body?: string | null | undefined;
  reviewCommentCount?: number | undefined;
}): boolean {
  if (review.authorLogin?.toLowerCase() !== COPILOT_REVIEWER_LOGIN) {
    return false;
  }
  if (review.state !== "COMMENTED" && review.state !== "APPROVED") {
    return false;
  }
  if ((review.reviewCommentCount ?? 0) !== 0) {
    return false;
  }
  const body = review.body ?? "";
  if (COPILOT_REVIEW_FAILURE_PATTERN.test(body)) {
    return false;
  }
  if (review.state === "APPROVED") {
    return true;
  }
  return COPILOT_REVIEW_SUCCESS_PATTERN.test(body);
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface PullRequestReviewThreadsQueryResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{ id: string; isResolved: boolean }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  } | null;
}

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  apiBaseUrl?: string;
  htmlBaseUrl?: string;
}

export class GitHubClient {
  private readonly apiBaseUrl: string;
  readonly htmlBaseUrl: string;
  readonly owner: string;
  readonly repo: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.htmlBaseUrl = options.htmlBaseUrl ?? "https://github.com";
    this.owner = options.owner;
    this.repo = options.repo;
  }

  repositoryUrl(): string {
    return `${this.htmlBaseUrl}/${this.owner}/${this.repo}`;
  }

  issueUrl(issueNumber: number): string {
    return `${this.repositoryUrl()}/issues/${issueNumber}`;
  }

  pullRequestUrl(pullRequestNumber: number): string {
    return `${this.repositoryUrl()}/pull/${pullRequestNumber}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "User-Agent": "vibrator",
        ...(init?.headers ?? {}),
      },
    });

    if (response.status === 404) {
      throw Object.assign(
        new Error(`GitHub request failed (404 Not Found) for ${path}`),
        { statusCode: 404 },
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status} ${response.statusText}) for ${path}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async graphqlRequest<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "Content-Type": "application/json",
        "User-Agent": "vibrator",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status} ${response.statusText}) for /graphql`);
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (!payload.data) {
      const messages = payload.errors?.map((error) => error.message).join("; ") ?? "Unknown GraphQL error";
      throw new Error(`GitHub GraphQL request failed: ${messages}`);
    }

    return payload.data;
  }

  private async getAllPages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      let response: T[];
      try {
        response = await this.request<T[]>(
          `${path}${separator}per_page=100&page=${page}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404) {
          console.warn(`[vibrator] WARNING: 404 for ${path} — skipping (check token permissions or repository slug).`);
          return results;
        }
        throw error;
      }
      results.push(...response);
      if (response.length < 100) {
        return results;
      }
      page += 1;
    }
  }

  async listOpenIssues(): Promise<Issue[]> {
    const issues = await this.getAllPages<GitHubIssueResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/issues?state=open`,
    );
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
      }));
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const [pullRequests, prGraphQLData] = await Promise.all([
      this.getAllPages<GitHubPullRequestResponse>(
        `/repos/${this.options.owner}/${this.options.repo}/pulls?state=open`,
      ),
      this.fetchOpenPullRequestGraphQLData(),
    ]);

    return pullRequests.map((pullRequest) => {
      const textForRegex = `${pullRequest.title}\n${pullRequest.body ?? ""}`;
      // GitHub's "Development" sidebar / closingIssuesReferences is the
      // authoritative source for which issues a PR closes — PRs opened by
      // the Copilot coding agent often link via the sidebar rather than
      // writing "Fixes #N" in the body. Merge it with any in-body keyword
      // references so we don't miss either source.
      const graphQLData = prGraphQLData.get(pullRequest.number);
      const linkedFromGitHub = graphQLData?.closingIssueNumbers ?? [];
      const linkedFromBody = parseLinkedIssueNumbers(textForRegex);
      const closingFromBody = parseClosingIssueNumbers(textForRegex);
      const linkedIssueNumbers = mergeSortedUnique(linkedFromGitHub, linkedFromBody);
      const closingIssueNumbers = mergeSortedUnique(linkedFromGitHub, closingFromBody);
      return {
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body ?? "",
        headSha: pullRequest.head.sha,
        headRefName: pullRequest.head.ref,
        state: pullRequest.state,
        draft: pullRequest.draft,
        hasMergeConflicts: graphQLData?.hasMergeConflicts ?? false,
        hasCleanCopilotReviewOnHead: graphQLData?.hasCleanCopilotReviewOnHead ?? false,
        createdAt: pullRequest.created_at,
        updatedAt: pullRequest.updated_at,
        linkedIssueNumbers,
        closingIssueNumbers,
      };
    });
  }

  private async fetchOpenPullRequestGraphQLData(): Promise<
    Map<
      number,
      {
        closingIssueNumbers: number[];
        hasMergeConflicts: boolean;
        hasCleanCopilotReviewOnHead: boolean;
      }
    >
  > {
    type ReviewNode = {
      author: { login: string } | null;
      state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
      submittedAt: string | null;
      commit: { oid: string } | null;
      body: string | null;
      comments: { totalCount: number };
    };
    type QueryResult = {
      repository: {
        pullRequests: {
          nodes: Array<{
            number: number;
            mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
            headRefOid: string;
            closingIssuesReferences: { nodes: Array<{ number: number }> } | null;
            reviews: { nodes: ReviewNode[] } | null;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };

    const result = new Map<
      number,
      {
        closingIssueNumbers: number[];
        hasMergeConflicts: boolean;
        hasCleanCopilotReviewOnHead: boolean;
      }
    >();
    let after: string | null = null;

    do {
      const data: QueryResult = await this.graphqlRequest<QueryResult>(
        `
          query OpenPullRequestGraphQLData($owner: String!, $repo: String!, $after: String) {
            repository(owner: $owner, name: $repo) {
              pullRequests(first: 50, states: OPEN, after: $after) {
                nodes {
                  number
                  mergeable
                  headRefOid
                  closingIssuesReferences(first: 50) { nodes { number } }
                  reviews(last: 30) {
                    nodes {
                      author { login }
                      state
                      submittedAt
                      commit { oid }
                      body
                      comments { totalCount }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        `,
        { owner: this.options.owner, repo: this.options.repo, after },
      );

      const pullRequests = data.repository?.pullRequests;
      if (!pullRequests) {
        return result;
      }

      for (const node of pullRequests.nodes) {
        const issueNumbers = node.closingIssuesReferences?.nodes.map((reference) => reference.number) ?? [];
        const reviewNodes = node.reviews?.nodes ?? [];
        // A "clean" Copilot review = the Copilot review bot submitted a review
        // on the current head sha that requested no changes, produced zero
        // review comments, AND whose body explicitly indicates success
        // ("generated no comments") — or is an APPROVED review. The body
        // check is critical: when Copilot posts "Copilot wasn't able to
        // review any files in this pull request." the GraphQL signals
        // (COMMENTED + 0 comments) otherwise look identical to a successful
        // empty review and would incorrectly authorize squash-and-merge.
        const hasCleanCopilotReviewOnHead = reviewNodes.some((review) => {
          if (review.commit?.oid !== node.headRefOid) {
            return false;
          }
          return isCleanCopilotReview({
            authorLogin: review.author?.login,
            state: review.state,
            body: review.body,
            reviewCommentCount: review.comments.totalCount,
          });
        });
        result.set(node.number, {
          closingIssueNumbers: [...new Set(issueNumbers)].sort((left, right) => left - right),
          // UNKNOWN means GitHub hasn't computed mergeability yet — treat conservatively as no conflict.
          hasMergeConflicts: node.mergeable === "CONFLICTING",
          hasCleanCopilotReviewOnHead,
        });
      }

      after = pullRequests.pageInfo.hasNextPage ? pullRequests.pageInfo.endCursor : null;
    } while (after);

    return result;
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }

  async assignIssueToCopilot(issueNumber: number): Promise<void> {
    const issueNodeId = await this.getIssueNodeId(issueNumber);
    const copilotBotId = await this.getCopilotAssigneeId();
    if (!copilotBotId) {
      throw new Error(
        `Cannot assign issue #${issueNumber} to Copilot: the Copilot coding agent is not available as an assignee on ${this.options.owner}/${this.options.repo}. Enable the Copilot coding agent for this repository and ensure your GITHUB_TOKEN has access.`,
      );
    }

    const data = await this.graphqlRequest<{
      replaceActorsForAssignable: {
        assignable: {
          assignees: { nodes: Array<{ login: string }> };
        } | null;
      };
    }>(
      `
        mutation AssignCopilot($assignableId: ID!, $actorIds: [ID!]!) {
          replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
            assignable {
              ... on Issue {
                assignees(first: 20) {
                  nodes { login }
                }
              }
            }
          }
        }
      `,
      { assignableId: issueNodeId, actorIds: [copilotBotId] },
    );

    const assignedLogins = data.replaceActorsForAssignable.assignable?.assignees.nodes.map(
      (node) => node.login.toLowerCase(),
    ) ?? [];
    if (!assignedLogins.some((login) => login === "copilot" || login === "copilot-swe-agent")) {
      throw new Error(
        `Assigning issue #${issueNumber} to Copilot did not take effect (final assignees: ${assignedLogins.join(", ") || "none"}).`,
      );
    }
  }

  private cachedCopilotAssigneeId: string | null | undefined;

  private async getCopilotAssigneeId(): Promise<string | null> {
    if (this.cachedCopilotAssigneeId !== undefined) {
      return this.cachedCopilotAssigneeId;
    }

    const data = await this.graphqlRequest<{
      repository: {
        suggestedActors: {
          nodes: Array<{ __typename: string; id: string; login: string }>;
        };
      } | null;
    }>(
      `
        query SuggestedAssignees($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
              nodes {
                __typename
                ... on Bot { id login }
                ... on User { id login }
                ... on Organization { id login }
                ... on Mannequin { id login }
              }
            }
          }
        }
      `,
      { owner: this.options.owner, repo: this.options.repo },
    );

    const nodes = data.repository?.suggestedActors.nodes ?? [];
    const copilotNode = nodes.find((node) => {
      const login = node.login?.toLowerCase();
      return login === "copilot" || login === "copilot-swe-agent";
    });
    this.cachedCopilotAssigneeId = copilotNode?.id ?? null;
    return this.cachedCopilotAssigneeId;
  }

  private async getIssueNodeId(issueNumber: number): Promise<string> {
    const data = await this.graphqlRequest<{
      repository: { issue: { id: string } | null } | null;
    }>(
      `
        query IssueNodeId($owner: String!, $repo: String!, $issueNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $issueNumber) { id }
          }
        }
      `,
      { owner: this.options.owner, repo: this.options.repo, issueNumber },
    );

    const id = data.repository?.issue?.id;
    if (!id) {
      throw new Error(`Could not resolve node id for issue #${issueNumber}.`);
    }
    return id;
  }

  async updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${this.options.owner}/${this.options.repo}/pulls/${pullRequestNumber}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }

  async mergePullRequest(pullRequestNumber: number): Promise<void> {
    await this.request(`/repos/${this.options.owner}/${this.options.repo}/pulls/${pullRequestNumber}/merge`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: "squash" }),
    });
  }

  /**
   * Squash-merges a pull request using `gh pr merge --squash`, passing the
   * provided subject and body as the commit message. We shell out to the
   * `gh` CLI here (rather than using the REST merge endpoint) so the squashed
   * commit's title and message body are exactly what the orchestrator
   * generated for the final pull-request description.
   */
  async squashMergePullRequest(
    pullRequestNumber: number,
    subject: string,
    body: string,
  ): Promise<void> {
    // Mark the PR ready for review first; draft PRs cannot be merged and
    // `gh pr merge` returns a "Pull Request is still a draft" GraphQL error
    // in that case. `gh pr ready` is a no-op on non-draft PRs.
    await runShellCommand("gh", [
      "pr",
      "ready",
      String(pullRequestNumber),
      "--repo",
      `${this.options.owner}/${this.options.repo}`,
    ]);
    await runShellCommand("gh", [
      "pr",
      "merge",
      String(pullRequestNumber),
      "--squash",
      "--subject",
      subject,
      "--body",
      body,
      "--repo",
      `${this.options.owner}/${this.options.repo}`,
    ]);
  }

  async listWorkflowRunsAwaitingApproval(): Promise<
    Array<{
      id: number;
      name: string;
      headBranch: string;
      event: string;
      status: string;
      htmlUrl: string;
    }>
  > {
    interface WorkflowRunResponse {
      id: number;
      name: string | null;
      head_branch: string | null;
      event: string;
      status: string | null;
      conclusion: string | null;
      html_url: string | null;
    }

    // Statuses that indicate a workflow run is awaiting approval. GitHub uses
    // `action_required` for first-time-contributor approval and `waiting` for
    // environment / deployment protection rule approvals.
    const PENDING_STATUSES = new Set(["action_required", "waiting"]);

    // Fetch recent runs without a status filter and inspect each — the
    // `?status=action_required` query filter has been observed to omit runs
    // that the UI shows as "Action required", so we filter client-side.
    let response: { workflow_runs?: WorkflowRunResponse[] };
    try {
      response = await this.request<{ workflow_runs?: WorkflowRunResponse[] }>(
        `/repos/${this.options.owner}/${this.options.repo}/actions/runs?per_page=100`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404) {
        return [];
      }
      throw error;
    }

    const matches: Array<{
      id: number;
      name: string;
      headBranch: string;
      event: string;
      status: string;
      htmlUrl: string;
    }> = [];

    for (const run of response.workflow_runs ?? []) {
      const actualStatus = run.status ?? "";
      const actualConclusion = run.conclusion ?? "";
      // A run is awaiting approval if either its status indicates pending
      // approval, or it's a completed run with conclusion=action_required
      // (e.g. previously-run workflows needing re-approval).
      const isPending =
        PENDING_STATUSES.has(actualStatus) || actualConclusion === "action_required";
      if (!isPending) {
        continue;
      }
      matches.push({
        id: run.id,
        name: run.name ?? "",
        headBranch: run.head_branch ?? "",
        event: run.event,
        status: actualConclusion === "action_required" ? "action_required" : actualStatus,
        htmlUrl: run.html_url ?? `${this.repositoryUrl()}/actions/runs/${run.id}`,
      });
    }

    return matches;
  }

  async approveWorkflowRun(runId: number): Promise<{ approved: boolean; reason?: string }> {
    try {
      await this.request(
        `/repos/${this.options.owner}/${this.options.repo}/actions/runs/${runId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      return { approved: true };
    } catch (error) {
      const statusCode = (error as NodeJS.ErrnoException & { statusCode?: number }).statusCode;
      // 403 is expected for same-repo branches — the /approve endpoint only works
      // for fork PRs from first-time external contributors.
      if (statusCode === 403) {
        return {
          approved: false,
          reason: "not a fork PR — /approve only applies to first-time external contributors",
        };
      }
      throw error;
    }
  }

  /**
   * Toggle a pull request from "Ready for review" → draft → "Ready for review"
   * to reset GitHub Copilot's pull-request review state. Copilot occasionally
   * fails a review with "Copilot wasn't able to review any files in this
   * pull request." (timeout, large diff, transient service issue). GitHub's
   * documented recovery is to convert the PR to draft and back, which clears
   * Copilot's cached state and lets a fresh review run. Used by the
   * orchestrator before re-requesting a Copilot review after a failed
   * attempt. No-op behaviour on draft PRs: still toggles via draft → ready.
   */
  async resetPullRequestForCopilotReview(pullRequestNumber: number): Promise<void> {
    const pullRequestNodeId = await this.getPullRequestNodeId(pullRequestNumber);
    await this.graphqlRequest(
      `
        mutation ConvertPullRequestToDraft($pullRequestId: ID!) {
          convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
            clientMutationId
          }
        }
      `,
      { pullRequestId: pullRequestNodeId },
    );
    await this.graphqlRequest(
      `
        mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            clientMutationId
          }
        }
      `,
      { pullRequestId: pullRequestNodeId },
    );
  }

  async requestCopilotReview(pullRequestNumber: number): Promise<void> {
    const pullRequestNodeId = await this.getPullRequestNodeId(pullRequestNumber);

    // Use the github.com-only `requestReviewsByLogin` GraphQL mutation to
    // register a formal pull-request review request from the Copilot code
    // review bot. The bot login requires the `[bot]` suffix on this mutation.
    // `union: true` ensures any existing reviewers are preserved.
    await this.graphqlRequest(
      `
        mutation RequestCopilotReview($pullRequestId: ID!, $botLogins: [String!]!) {
          requestReviewsByLogin(
            input: { pullRequestId: $pullRequestId, botLogins: $botLogins, union: true }
          ) {
            clientMutationId
          }
        }
      `,
      {
        pullRequestId: pullRequestNodeId,
        botLogins: ["copilot-pull-request-reviewer[bot]"],
      },
    );
  }

  private async getPullRequestNodeId(pullRequestNumber: number): Promise<string> {
    const data = await this.graphqlRequest<{
      repository: { pullRequest: { id: string } | null } | null;
    }>(
      `
        query PullRequestNodeId($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pullRequestNumber) { id }
          }
        }
      `,
      { owner: this.options.owner, repo: this.options.repo, pullRequestNumber },
    );

    const id = data.repository?.pullRequest?.id;
    if (!id) {
      throw new Error(`Could not resolve node id for pull request #${pullRequestNumber}.`);
    }
    return id;
  }

  async resolvePullRequestReviewThreads(pullRequestNumber: number): Promise<void> {
    const unresolvedThreadIds = await this.listUnresolvedPullRequestReviewThreadIds(
      pullRequestNumber,
    );

    for (const threadId of unresolvedThreadIds) {
      await this.graphqlRequest(
        `
          mutation ResolveReviewThread($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
              thread {
                id
              }
            }
          }
        `,
        { threadId },
      );
    }
  }

  async listPullRequestReviews(
    pullRequestNumber: number,
  ): Promise<
    Array<{
      submittedAt: string;
      authorLogin?: string;
      state?: string;
      body?: string | null;
    }>
  > {
    const reviews = await this.getAllPages<GitHubPullRequestReviewResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/pulls/${pullRequestNumber}/reviews`,
    );
    return reviews
      .filter((review): review is GitHubPullRequestReviewResponse & { submitted_at: string } =>
        review.submitted_at !== null,
      )
      .map((review) => {
        const result: {
          submittedAt: string;
          authorLogin?: string;
          state?: string;
          body?: string | null;
        } = { submittedAt: review.submitted_at };
        if (review.user?.login !== undefined) {
          result.authorLogin = review.user.login;
        }
        if (review.state !== undefined) {
          result.state = review.state;
        }
        result.body = review.body;
        return result;
      });
  }

  async countUnresolvedPullRequestReviewThreads(pullRequestNumber: number): Promise<number> {
    return (
      await this.listUnresolvedPullRequestReviewThreadIds(
        pullRequestNumber,
      )
    ).length;
  }

  /**
   * Returns timestamps of "Copilot finished work" timeline events on a
   * pull request. These events are emitted by the Copilot coding agent
   * each time it ends a session (whether it pushed commits or only
   * replied with a comment such as "no change needed"). The orchestrator
   * uses this signal to detect when an address-review-comments session is
   * effectively complete even though no new commits were pushed.
   *
   * The GitHub REST timeline endpoint returns events with an `event`
   * string field; the exact name for Copilot's session events may vary
   * over time, so this matches any event whose name contains both
   * "copilot" and a completion verb (finish/complete/end).
   */
  async listCopilotFinishedWorkEvents(
    pullRequestNumber: number,
  ): Promise<Array<{ createdAt: string }>> {
    interface TimelineEvent {
      event?: string;
      created_at?: string;
      actor?: { login?: string } | null;
      performed_via_github_app?: { slug?: string } | null;
    }
    const events = await this.getAllPages<TimelineEvent>(
      `/repos/${this.options.owner}/${this.options.repo}/issues/${pullRequestNumber}/timeline`,
    );
    return events
      .filter((event): event is TimelineEvent & { created_at: string } => {
        if (!event.created_at) return false;
        const name = (event.event ?? "").toLowerCase();
        return (
          name.includes("copilot") &&
          (name.includes("finish") || name.includes("complete") || name.includes("end"))
        );
      })
      .map((event) => ({ createdAt: event.created_at }));
  }

  private async listUnresolvedPullRequestReviewThreadIds(
    pullRequestNumber: number,
  ): Promise<string[]> {
    const unresolvedThreadIds: string[] = [];
    let after: string | null = null;

    do {
      const data: PullRequestReviewThreadsQueryResponse = await this.graphqlRequest(
        `
          query ResolveReviewThreads($owner: String!, $repo: String!, $pullRequestNumber: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $pullRequestNumber) {
                reviewThreads(first: 100, after: $after) {
                  nodes {
                    id
                    isResolved
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        {
          owner: this.options.owner,
          repo: this.options.repo,
          pullRequestNumber,
          after,
        },
      );

      const reviewThreads = data.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) {
        return unresolvedThreadIds;
      }

      for (const thread of reviewThreads.nodes) {
        if (!thread.isResolved) {
          unresolvedThreadIds.push(thread.id);
        }
      }

      after = reviewThreads.pageInfo.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
    } while (after);

    return unresolvedThreadIds;
  }
}

export async function loadSnapshot(
  gitHubClient: GitHubClient,
  sessionStore: FileSessionStore,
): Promise<RepositorySnapshot> {
  const [issues, pullRequests, agentSessions] = await Promise.all([
    gitHubClient.listOpenIssues(),
    gitHubClient.listOpenPullRequests(),
    sessionStore.load(),
  ]);

  return { issues, pullRequests, agentSessions };
}

export function buildDefaultSessionStorePath(owner: string, repo: string): string {
  return join(process.cwd(), ".vibrator", `${owner}-${repo}-sessions.json`);
}
