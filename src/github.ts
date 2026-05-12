import { spawn } from "node:child_process";
import { join } from "node:path";

import { parseClosingIssueNumbers, parseLinkedIssueNumbers } from "./orchestrator.js";
import { FileSessionStore } from "./session-store.js";
import type {
  Issue,
  PullRequest,
  PullRequestInlineComment,
  RepositorySnapshot,
} from "./types.js";

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
  type?: { name?: string | null } | null;
}

interface GitHubPullRequestResponse {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
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
  commit_id: string | null;
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

/** Identifier vibrator uses when posting reviews so we can recognize our own reviews later. */
export const VIBRATOR_REVIEW_MARKER = "<!-- vibrator-review -->";

export function isVibratorReview(body: string | null | undefined): boolean {
  return !!body && body.includes(VIBRATOR_REVIEW_MARKER);
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

  async getDefaultBranch(): Promise<string> {
    const data = await this.request<{ default_branch: string }>(
      `/repos/${this.options.owner}/${this.options.repo}`,
    );
    return data.default_branch;
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
        type: issue.type?.name ?? null,
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
        baseRefName: pullRequest.base.ref,
        state: pullRequest.state,
        draft: pullRequest.draft,
        hasMergeConflicts: graphQLData?.hasMergeConflicts ?? false,
        hasCleanReviewOnHead: graphQLData?.hasCleanReviewOnHead ?? false,
        unresolvedReviewCommentCount: graphQLData?.unresolvedReviewCommentCount ?? 0,
        checksStatus: graphQLData?.checksStatus ?? "none",
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
        hasCleanReviewOnHead: boolean;
        unresolvedReviewCommentCount: number;
        checksStatus: "success" | "failure" | "pending" | "none";
      }
    >
  > {
    type ReviewNode = {
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
            reviewThreads: {
              nodes: Array<{ isResolved: boolean }>;
            } | null;
            commits: {
              nodes: Array<{
                commit: {
                  oid: string;
                  statusCheckRollup: { state: string } | null;
                };
              }>;
            } | null;
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
        hasCleanReviewOnHead: boolean;
        unresolvedReviewCommentCount: number;
        checksStatus: "success" | "failure" | "pending" | "none";
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
                      state
                      submittedAt
                      commit { oid }
                      body
                      comments { totalCount }
                    }
                  }
                  reviewThreads(first: 100) {
                    nodes { isResolved }
                  }
                  commits(last: 1) {
                    nodes {
                      commit {
                        oid
                        statusCheckRollup { state }
                      }
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
        // A "clean review on head" = a vibrator-tagged review on the
        // current head sha that contains no inline comments and is not
        // a CHANGES_REQUESTED review.
        const hasCleanReviewOnHead = reviewNodes.some((review) => {
          if (review.commit?.oid !== node.headRefOid) return false;
          if (!isVibratorReview(review.body)) return false;
          if (review.state === "CHANGES_REQUESTED") return false;
          if ((review.comments?.totalCount ?? 0) !== 0) return false;
          return review.state === "APPROVED" || review.state === "COMMENTED";
        });

        const unresolvedReviewCommentCount =
          node.reviewThreads?.nodes.filter((thread) => !thread.isResolved).length ?? 0;

        const headCommitNode = node.commits?.nodes[0]?.commit;
        const rollupState = (
          headCommitNode?.oid === node.headRefOid
            ? headCommitNode?.statusCheckRollup?.state
            : undefined
        )?.toUpperCase();
        let checksStatus: "success" | "failure" | "pending" | "none";
        if (rollupState === "FAILURE" || rollupState === "ERROR") {
          checksStatus = "failure";
        } else if (rollupState === "PENDING" || rollupState === "EXPECTED") {
          checksStatus = "pending";
        } else if (rollupState === "SUCCESS") {
          checksStatus = "success";
        } else {
          checksStatus = "none";
        }
        result.set(node.number, {
          closingIssueNumbers: [...new Set(issueNumbers)].sort((left, right) => left - right),
          hasMergeConflicts: node.mergeable === "CONFLICTING",
          hasCleanReviewOnHead,
          unresolvedReviewCommentCount,
          checksStatus,
        });
      }

      after = pullRequests.pageInfo.hasNextPage ? pullRequests.pageInfo.endCursor : null;
    } while (after);

    return result;
  }

  /**
   * Create a pull request. Returns the new PR number and head SHA.
   */
  async createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ number: number; headSha: string }> {
    const response = await this.request<{
      number: number;
      head: { sha: string };
    }>(`/repos/${this.options.owner}/${this.options.repo}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
      }),
    });
    return { number: response.number, headSha: response.head.sha };
  }

  /**
   * Submit a pull-request review. When `inlineComments` is empty, the
   * review is approved; when present, it is submitted as
   * REQUEST_CHANGES so the author knows action is required.
   */
  async createPullRequestReview(input: {
    pullRequestNumber: number;
    commitId: string;
    body: string;
    inlineComments: ReadonlyArray<PullRequestInlineComment>;
  }): Promise<void> {
    const event =
      input.inlineComments.length === 0 ? "APPROVE" : "REQUEST_CHANGES";
    const bodyWithMarker = `${VIBRATOR_REVIEW_MARKER}\n\n${input.body}`.trim();
    await this.request(
      `/repos/${this.options.owner}/${this.options.repo}/pulls/${input.pullRequestNumber}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commit_id: input.commitId,
          body: bodyWithMarker,
          event,
          comments: input.inlineComments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: "RIGHT",
            body: comment.body,
          })),
        }),
      },
    );
  }

  async createIssueComment(issueNumber: number, body: string): Promise<{ id: number }> {
    const response = await this.request<{ id: number }>(
      `/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    return { id: response.id };
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
   * Squash-merges a pull request using `gh pr merge --squash`, passing
   * the provided subject and body as the commit message.
   */
  async squashMergePullRequest(
    pullRequestNumber: number,
    subject: string,
    body: string,
  ): Promise<void> {
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

    const PENDING_STATUSES = new Set(["action_required", "waiting"]);

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
   * Return the unresolved review comments on a pull request, in order.
   * Each entry includes the comment body, file path, line number (or
   * null when the comment isn't attached to a specific line), and the
   * author login. Used to seed the prompt sent to Claude when asked to
   * address review comments.
   */
  async listUnresolvedReviewComments(pullRequestNumber: number): Promise<
    Array<{ path: string; line: number | null; body: string; author: string }>
  > {
    interface ThreadComment {
      databaseId: number;
      path: string;
      line: number | null;
      body: string;
      author: { login: string } | null;
    }
    interface ThreadNode {
      isResolved: boolean;
      comments: { nodes: ThreadComment[] };
    }
    interface QueryResult {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: ThreadNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } | null;
    }
    const results: Array<{
      path: string;
      line: number | null;
      body: string;
      author: string;
    }> = [];
    let after: string | null = null;
    do {
      const data: QueryResult = await this.graphqlRequest<QueryResult>(
        `
          query UnresolvedReviewComments($owner: String!, $repo: String!, $pullRequestNumber: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $pullRequestNumber) {
                reviewThreads(first: 50, after: $after) {
                  nodes {
                    isResolved
                    comments(first: 50) {
                      nodes {
                        databaseId
                        path
                        line
                        body
                        author { login }
                      }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
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
      const threads = data.repository?.pullRequest?.reviewThreads;
      if (!threads) break;
      for (const thread of threads.nodes) {
        if (thread.isResolved) continue;
        for (const comment of thread.comments.nodes) {
          results.push({
            path: comment.path,
            line: comment.line,
            body: comment.body,
            author: comment.author?.login ?? "unknown",
          });
        }
      }
      after = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
    } while (after);
    return results;
  }

  /**
   * Return failing check runs for the head SHA of a pull request, with a
   * short log excerpt for each. Used to seed the prompt for the
   * `address-failing-checks` action.
   */
  async listFailingCheckRuns(input: {
    pullRequestNumber: number;
    headSha: string;
  }): Promise<Array<{ name: string; logExcerpt: string }>> {
    interface CheckRun {
      id: number;
      name: string;
      conclusion: string | null;
      status: string | null;
      output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
    }
    let response: { check_runs?: CheckRun[] };
    try {
      response = await this.request<{ check_runs?: CheckRun[] }>(
        `/repos/${this.options.owner}/${this.options.repo}/commits/${input.headSha}/check-runs?per_page=100`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404) {
        return [];
      }
      throw error;
    }
    const failing = (response.check_runs ?? []).filter(
      (run) => run.conclusion === "failure" || run.conclusion === "timed_out",
    );
    return failing.map((run) => {
      const summary = run.output?.summary ?? "";
      const text = run.output?.text ?? "";
      const combined = [summary, text].filter(Boolean).join("\n\n");
      const excerpt = combined.length > 4000 ? combined.slice(0, 4000) + "\n…(truncated)" : combined;
      return { name: run.name, logExcerpt: excerpt || "(no log excerpt available)" };
    });
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
              thread { id }
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
      commitId?: string | null;
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
          commitId?: string | null;
        } = { submittedAt: review.submitted_at };
        if (review.user?.login !== undefined) {
          result.authorLogin = review.user.login;
        }
        if (review.state !== undefined) {
          result.state = review.state;
        }
        result.body = review.body;
        result.commitId = review.commit_id;
        return result;
      });
  }

  async countUnresolvedPullRequestReviewThreads(pullRequestNumber: number): Promise<number> {
    return (
      await this.listUnresolvedPullRequestReviewThreadIds(pullRequestNumber)
    ).length;
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
                  nodes { id isResolved }
                  pageInfo { hasNextPage endCursor }
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
