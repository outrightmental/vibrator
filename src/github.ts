import { join } from "node:path";

import { parseClosingIssueNumbers, parseLinkedIssueNumbers } from "./orchestrator.js";
import { FileSessionStore } from "./session-store.js";
import type {
  Commit,
  Issue,
  PullRequest,
  RepositorySnapshot,
} from "./types.js";

/**
 * Returns the GitHub token configured for Vibrator.
 * Prefers the app-specific variable, then common GitHub token variables.
 */
export function getGitHubTokenFromEnv(): string {
  for (const name of ["VIBRATOR_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const token = process.env[name]?.trim();
    if (token) {
      return token;
    }
  }
  throw new Error(
    "Missing GitHub token. Set VIBRATOR_GITHUB_TOKEN or GITHUB_TOKEN to a GitHub PAT with access to the target repository.",
  );
}

interface PullRequestInlineComment {
  path: string;
  line: number;
  body: string;
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
  milestone?: { number: number; title: string } | null;
  labels?: Array<{ name: string }>;
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
  labels?: Array<{ name: string }>;
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

interface ProjectMeta {
  id: string;
  statusFieldId: string;
  statusOptions: Array<{ id: string; name: string }>;
}

function isBranchProtectionMergeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const statusCode = (error as Error & { statusCode?: number }).statusCode;
  return (
    statusCode === 403 ||
    statusCode === 405 ||
    statusCode === 409 ||
    /base branch policy prohibits the merge|protected branch|branch protection/i.test(error.message)
  );
}

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

/** Where a human comment on a PR came from. */
export type PullRequestCommentKind = "conversation" | "review" | "review-thread";

export interface PullRequestComment {
  /**
   * GitHub's numeric id for the comment (the issue-comment id, review id, or
   * review-thread-comment id depending on `kind`). Used both to skip
   * Vibrator's own comments and to attach reaction emoji.
   */
  id: number;
  author: string;
  body: string;
  createdAt: string;
  /** Web URL of the comment/review, so it can be linked back to. */
  url: string;
  /** Whether this is a conversation comment, a review summary, or an inline review-thread comment. */
  kind: PullRequestCommentKind;
}

/**
 * Hidden marker appended to every comment Vibrator posts. Used to tell
 * Vibrator's own comments apart from human comments by content rather than by
 * author login — Vibrator may run under the same GitHub account as a human
 * reviewer, in which case login-based filtering would also discard the
 * human's comments.
 */
export const VIBRATOR_COMMENT_MARKER = "<!-- vibrator:automated-comment -->";

export class GitHubClient {
  private readonly apiBaseUrl: string;
  readonly htmlBaseUrl: string;
  readonly owner: string;
  readonly repo: string;
  private authenticatedLoginCache: Promise<string> | undefined;

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
    const url = `${this.apiBaseUrl}${path}`;
    const response = await fetch(url, {
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

    if (response.status === 403) {
      throw Object.assign(
        new Error(`GitHub request failed (403 Forbidden) for ${path}`),
        { statusCode: 403 },
      );
    }

    if (!response.ok) {
      // Read the body for full triage context before throwing.
      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = "(could not read response body)";
      }

      // Redact auth from request headers for safe logging.
      const requestHeaders: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "vibrator",
        ...(init?.headers as Record<string, string> ?? {}),
      };
      delete requestHeaders["Authorization"];

      let requestBodySummary: string;
      if (typeof init?.body === "string") {
        try {
          // Pretty-print JSON bodies for readability.
          requestBodySummary = JSON.stringify(JSON.parse(init.body), null, 2);
        } catch {
          requestBodySummary = init.body;
        }
      } else {
        requestBodySummary = "(no body)";
      }

      console.error(
        `[vibrator] GitHub ${response.status} ${response.statusText} — full triage context:\n` +
        `  Method : ${init?.method ?? "GET"}\n` +
        `  URL    : ${url}\n` +
        `  Request headers (redacted): ${JSON.stringify(requestHeaders)}\n` +
        `  Request body:\n${requestBodySummary}\n` +
        `  Response body:\n${responseBody}`,
      );

      throw Object.assign(
        new Error(
          `GitHub request failed (${response.status} ${response.statusText}) for ${path}. ` +
          `Response body: ${responseBody}`,
        ),
        { statusCode: response.status },
      );
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
          console.warn(`[vibrator] WARNING: 404 for ${path} — skipping (check GitHub token permissions or repository slug).`);
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

  /**
   * Returns the GitHub login of the currently authenticated user (the bot
   * account running vibrator). Result is cached per client instance.
   */
  async getAuthenticatedLogin(): Promise<string> {
    if (!this.authenticatedLoginCache) {
      this.authenticatedLoginCache = this.graphqlRequest<{ viewer: { login: string } }>(
        `query { viewer { login } }`,
        {},
      ).then((data) => data.viewer.login);
    }
    return this.authenticatedLoginCache;
  }

  /**
   * Lists feedback left on a pull request by humans. This spans all three
   * places GitHub stores PR feedback:
   *   - issue "conversation" comments (`/issues/{n}/comments`)
   *   - review summaries, e.g. "Request changes" (`/pulls/{n}/reviews`)
   *   - inline review-thread comments (`/pulls/{n}/comments`)
   *
   * Vibrator's own automated comments are excluded two ways: by looking for
   * the hidden {@link VIBRATOR_COMMENT_MARKER} (login can't be used because
   * Vibrator may run under the same GitHub account as a human reviewer), and
   * by skipping any comment id in `options.excludeCommentIds` — the persisted
   * set of ids Vibrator has posted. Comments authored by other bot accounts
   * (e.g. `github-actions[bot]`) are also excluded.
   *
   * Comments that already carry a 👀 ("eyes") reaction are also excluded:
   * Vibrator reacts 👀 to every comment it consumes (see {@link addEyesReaction}),
   * so the reaction marks a comment as already read and prevents it from being
   * fed into — and addressed by — the same review again on every cycle. (PR
   * review summaries have no reactions endpoint, so this filter does not apply
   * to `kind: "review"`.)
   */
  async listPullRequestComments(
    pullRequestNumber: number,
    options?: { excludeCommentIds?: ReadonlySet<number> },
  ): Promise<PullRequestComment[]> {
    const { owner, repo } = this.options;
    const excluded = options?.excludeCommentIds ?? new Set<number>();
    const [issueComments, reviews, reviewThreadComments] = await Promise.all([
      this.getAllPages<{
        id: number;
        user: { login: string; type?: string } | null;
        body: string;
        created_at: string;
        html_url: string;
        reactions?: { eyes?: number };
      }>(`/repos/${owner}/${repo}/issues/${pullRequestNumber}/comments`),
      this.getAllPages<{
        id: number;
        user: { login: string; type?: string } | null;
        body: string | null;
        submitted_at: string | null;
        html_url: string;
      }>(`/repos/${owner}/${repo}/pulls/${pullRequestNumber}/reviews`),
      this.getAllPages<{
        id: number;
        user: { login: string; type?: string } | null;
        body: string;
        created_at: string;
        html_url: string;
        reactions?: { eyes?: number };
      }>(`/repos/${owner}/${repo}/pulls/${pullRequestNumber}/comments`),
    ]);

    // True when a comment already carries a 👀 reaction — Vibrator has read it.
    const alreadyRead = (reactions?: { eyes?: number }): boolean =>
      (reactions?.eyes ?? 0) > 0;

    // A comment counts as human feedback unless it was posted by a bot
    // account, carries one of Vibrator's own markers (the automated-comment
    // marker for issue comments, or the review marker for posted reviews), or
    // its id is in the persisted set of comments Vibrator has posted.
    const isHumanFeedback = (
      id: number,
      user: { type?: string } | null,
      body: string | null,
    ): boolean => {
      if (excluded.has(id)) return false;
      if (user?.type === "Bot") return false;
      if (body === null) return true;
      if (body.includes(VIBRATOR_COMMENT_MARKER)) return false;
      if (body.includes(VIBRATOR_REVIEW_MARKER)) return false;
      return true;
    };

    const result: PullRequestComment[] = [];

    for (const comment of issueComments) {
      if (!isHumanFeedback(comment.id, comment.user, comment.body)) continue;
      if (alreadyRead(comment.reactions)) continue;
      result.push({
        id: comment.id,
        author: comment.user?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.created_at,
        url: comment.html_url,
        kind: "conversation",
      });
    }

    for (const review of reviews) {
      // Skip reviews with no submitted timestamp (pending) and reviews with
      // an empty body (a bare approve/comment with only inline comments —
      // those inline comments are fetched separately below).
      if (review.submitted_at === null) continue;
      if (review.body === null || review.body.trim() === "") continue;
      if (!isHumanFeedback(review.id, review.user, review.body)) continue;
      result.push({
        id: review.id,
        author: review.user?.login ?? "unknown",
        body: review.body,
        createdAt: review.submitted_at,
        url: review.html_url,
        kind: "review",
      });
    }

    for (const comment of reviewThreadComments) {
      if (!isHumanFeedback(comment.id, comment.user, comment.body)) continue;
      if (alreadyRead(comment.reactions)) continue;
      result.push({
        id: comment.id,
        author: comment.user?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.created_at,
        url: comment.html_url,
        kind: "review-thread",
      });
    }

    return result.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  /**
   * Adds the 👀 ("eyes") reaction to a PR comment, marking it as read by
   * Vibrator. Conversation comments and inline review-thread comments support
   * reactions; PR review summaries do not have a reactions endpoint, so those
   * are silently skipped. Failures are swallowed — a missing reaction must
   * never abort the surrounding action.
   */
  async addEyesReaction(comment: PullRequestComment): Promise<void> {
    const { owner, repo } = this.options;
    let path: string | undefined;
    if (comment.kind === "conversation") {
      path = `/repos/${owner}/${repo}/issues/comments/${comment.id}/reactions`;
    } else if (comment.kind === "review-thread") {
      path = `/repos/${owner}/${repo}/pulls/comments/${comment.id}/reactions`;
    }
    if (path === undefined) {
      return;
    }
    try {
      await this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "eyes" }),
      });
    } catch (error) {
      console.warn(
        `[vibrator] Could not add 👀 reaction to comment ${comment.id} on PR: ${String(error)}`,
      );
    }
  }

  async listOpenIssues(): Promise<Issue[]> {
    const [issues, parentNumbers] = await Promise.all([
      this.getAllPages<GitHubIssueResponse>(
        `/repos/${this.options.owner}/${this.options.repo}/issues?state=open`,
      ),
      this.fetchOpenIssueParentNumbers(),
    ]);
    const openIssueNumbers = new Set(
      issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => issue.number),
    );
    const blockedByNumbers = await this.fetchOpenIssueBlockedByNumbers(openIssueNumbers);
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => {
        const parentNumber = parentNumbers.get(issue.number);
        const blockedBy = blockedByNumbers.get(issue.number);
        return {
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          state: issue.state,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          type: issue.type?.name ?? null,
          labels: (issue.labels ?? []).map((label) => label.name),
          ...(parentNumber !== undefined ? { parentNumber } : {}),
          ...(blockedBy && blockedBy.length > 0
            ? { blockedByIssueNumbers: blockedBy }
            : {}),
          ...(issue.milestone
            ? { milestone: { number: issue.milestone.number, title: issue.milestone.title } }
            : {}),
        };
      });
  }

  /**
   * Returns a map of open sub-issue number → parent issue number for all
   * open issues that have a parent (i.e. are sub-issues).
   *
   * GitHub's `parent` field on issues is a beta/rolling-out feature. If the
   * field is not yet available on this instance the GraphQL query will fail;
   * in that case we log a warning and return an empty map so the rest of the
   * orchestrator continues to work without parent-based blocking.
   */
  private async fetchOpenIssueParentNumbers(): Promise<Map<number, number>> {
    type QueryResult = {
      repository: {
        issues: {
          nodes: Array<{
            number: number;
            parent: { number: number } | null;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };

    const result = new Map<number, number>();
    let after: string | null = null;

    try {
      do {
        const data: QueryResult = await this.graphqlRequest<QueryResult>(
          `
            query OpenIssueParentNumbers($owner: String!, $repo: String!, $after: String) {
              repository(owner: $owner, name: $repo) {
                issues(states: OPEN, first: 100, after: $after) {
                  nodes {
                    number
                    parent {
                      number
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          `,
          { owner: this.options.owner, repo: this.options.repo, after },
        );

        const issuesPage = data.repository?.issues;
        if (!issuesPage) {
          break;
        }

        for (const node of issuesPage.nodes) {
          if (node.parent !== null) {
            result.set(node.number, node.parent.number);
          }
        }

        after = issuesPage.pageInfo.hasNextPage ? issuesPage.pageInfo.endCursor : null;
      } while (after);
    } catch (error) {
      console.warn(
        `[vibrator] Could not fetch issue parent numbers — sub-issues may not be available on this repository: ` +
        `${String(error)}. Parent/child blocking will be skipped.`,
      );
    }

    return result;
  }

  /**
   * Returns a map of open issue number → list of open issue numbers that
   * block it, sourced from GitHub's native Issue Dependencies feature
   * (REST `/issues/{n}/dependencies/blocked_by`).
   *
   * This is distinct from sub-issue parent/child links and from body-text
   * "blocked by #N" mentions. Without this call, blockers configured
   * through the GitHub UI's Dependencies panel are invisible to the
   * orchestrator and blocked issues are picked up anyway.
   *
   * Closed blockers are filtered out — they cannot block anything. Issues
   * blocked only by closed (or otherwise non-open) blockers are omitted
   * from the result map entirely.
   *
   * Issue Dependencies is a rolling-out GitHub feature. If the endpoint
   * is unavailable on a given repository the call returns 404 (or some
   * other error); the failure is logged once and the orchestrator
   * continues to work without dependency-based blocking.
   */
  private async fetchOpenIssueBlockedByNumbers(
    openIssueNumbers: ReadonlySet<number>,
  ): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>();
    let featureUnavailable = false;

    const lookups = [...openIssueNumbers].map(async (issueNumber) => {
      if (featureUnavailable) return;
      try {
        const blockers = await this.request<Array<{ number: number; state: string }>>(
          `/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}/dependencies/blocked_by`,
        );
        const openBlockers = blockers
          .filter((blocker) => blocker.state === "open" && openIssueNumbers.has(blocker.number))
          .map((blocker) => blocker.number)
          .sort((left, right) => left - right);
        if (openBlockers.length > 0) {
          result.set(issueNumber, openBlockers);
        }
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Feature not available on this repo — stop trying and let the
          // orchestrator proceed without dependency-based blocking.
          if (!featureUnavailable) {
            featureUnavailable = true;
            console.warn(
              `[vibrator] Could not fetch issue dependencies — the Issue Dependencies feature ` +
              `may not be enabled on this repository (${statusCode}). ` +
              `GitHub-native "blocked by" relationships will be skipped.`,
            );
          }
          return;
        }
        // Transient or unexpected failure on a single issue: log and keep
        // going so one bad call doesn't poison the whole list.
        console.warn(
          `[vibrator] Could not fetch dependencies for issue #${issueNumber}: ${String(error)}.`,
        );
      }
    });

    await Promise.all(lookups);
    return result;
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
        headCommitPushedAt: graphQLData?.headCommitPushedAt,
        createdAt: pullRequest.created_at,
        updatedAt: pullRequest.updated_at,
        labels: (pullRequest.labels ?? []).map((label) => label.name),
        linkedIssueNumbers,
        closingIssueNumbers,
      };
    });
  }

  async listRecentCommits(limit: number = 10): Promise<Commit[]> {
    interface GitHubCommitResponse {
      sha: string;
      commit: {
        author: { name: string };
        message: string;
      };
      pushed_at?: string;
    }

    const commits = await this.getAllPages<GitHubCommitResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/commits?per_page=${limit}`,
    );

    return commits.slice(0, limit).map((commit) => ({
      hash: commit.sha,
      author: commit.commit.author.name,
      message: commit.commit.message,
      pushedAt: commit.pushed_at || new Date().toISOString(),
    }));
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
        headCommitPushedAt: string | undefined;
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
                  pushedDate: string | null;                  committedDate: string | null;                  statusCheckRollup: { state: string } | null;
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
        headCommitPushedAt: string | undefined;
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
                        pushedDate
                        committedDate
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
        const headCommitPushedAt =
          headCommitNode?.oid === node.headRefOid
            ? (headCommitNode?.pushedDate ?? headCommitNode?.committedDate ?? undefined)
            : undefined;
        result.set(node.number, {
          closingIssueNumbers: [...new Set(issueNumbers)].sort((left, right) => left - right),
          hasMergeConflicts: node.mergeable === "CONFLICTING",
          hasCleanReviewOnHead,
          unresolvedReviewCommentCount,
          checksStatus,
          headCommitPushedAt,
        });
      }

      after = pullRequests.pageInfo.hasNextPage ? pullRequests.pageInfo.endCursor : null;
    } while (after);

    return result;
  }

  /**
   * Find an open pull request for a given head branch, or undefined if none exists.
   */
  private async findOpenPullRequestByHeadBranch(headBranch: string): Promise<
    { number: number; headSha: string } | undefined
  > {
    const pullRequests = await this.request<
      Array<{ number: number; head: { sha: string } }>
    >(
      `/repos/${this.options.owner}/${this.options.repo}/pulls?state=open&head=${encodeURIComponent(`${this.options.owner}:${headBranch}`)}`,
    );
    if (pullRequests.length === 0) {
      return undefined;
    }
    return {
      number: pullRequests[0]!.number,
      headSha: pullRequests[0]!.head.sha,
    };
  }

  /**
   * Create a pull request. Returns the PR number, head SHA, and a flag indicating
   * whether the PR was newly created or already existed.
   * If a PR already exists for the head branch, returns the existing PR with created=false.
   */
  async createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ number: number; headSha: string; created: boolean }> {
    // Check if a PR already exists for this head branch to avoid 422.
    const existing = await this.findOpenPullRequestByHeadBranch(input.head);
    if (existing !== undefined) {
      return { ...existing, created: false };
    }

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
    return { number: response.number, headSha: response.head.sha, created: true };
  }

  /**
   * Submit a pull-request review.
   *
   * - No inline comments → APPROVE (clean review).
   * - Inline comments present → COMMENT with inline threads. COMMENT is used
   *   instead of REQUEST_CHANGES because GitHub forbids REQUEST_CHANGES on
   *   PRs authored by the same token, and COMMENT still creates proper
   *   unresolved review threads that the orchestrator can pick up.
   *
   * Fallback: if the GitHub API rejects inline comments with 422 "Line could
   * not be resolved" (the comment targets a line not in the diff), we retry
   * as a body-only COMMENT with all inline comments folded into the review
   * body so no feedback is lost.
   */
  async createPullRequestReview(input: {
    pullRequestNumber: number;
    commitId: string;
    body: string;
    inlineComments: ReadonlyArray<PullRequestInlineComment>;
  }): Promise<void> {
    const bodyWithMarker = `${VIBRATOR_REVIEW_MARKER}\n\n${input.body}`.trim();

    const postReview = async (
      event: "APPROVE" | "COMMENT",
      reviewBody: string,
      comments: ReadonlyArray<PullRequestInlineComment>,
    ): Promise<void> => {
      await this.request(
        `/repos/${this.options.owner}/${this.options.repo}/pulls/${input.pullRequestNumber}/reviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commit_id: input.commitId,
            body: reviewBody,
            event,
            comments: comments.map((comment) => ({
              path: comment.path,
              line: comment.line,
              side: "RIGHT",
              body: comment.body,
            })),
          }),
        },
      );
    };

    // Clean review: no inline comments → APPROVE.
    // Issues found: use COMMENT (not REQUEST_CHANGES) so the same token that
    // opened the PR can post inline review threads without a 422 error.
    const event = input.inlineComments.length === 0 ? "APPROVE" : "COMMENT";

    try {
      await postReview(event, bodyWithMarker, input.inlineComments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "Line could not be resolved" — inline comment targets a line not
      // visible in the diff. Fold all comments into the review body so the
      // feedback is still recorded even without proper threads.
      if (
        input.inlineComments.length > 0 &&
        message.includes("422") &&
        message.includes("Line could not be resolved")
      ) {
        console.warn(
          `[vibrator] Review inline comments could not be resolved to diff lines on PR #${input.pullRequestNumber}. ` +
          `Falling back to body-only COMMENT review with ${input.inlineComments.length} comment(s) in body.`,
        );
        const commentSection = input.inlineComments
          .map((c) => `**\`${c.path}\`** (line ${c.line})\n${c.body}`)
          .join("\n\n---\n\n");
        await postReview(
          "COMMENT",
          `${bodyWithMarker}\n\n---\n\n### Inline comments\n\n${commentSection}`,
          [],
        );
        return;
      }
      throw error;
    }
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

  /**
   * Posts a comment on a PR and returns its numeric id, so the caller can
   * persist it and skip re-reading Vibrator's own comment later.
   */
  async postComment(pullRequestNumber: number, body: string): Promise<number> {
    // Append the hidden marker so listPullRequestComments can recognise this
    // as Vibrator's own comment even when Vibrator runs under a human's
    // GitHub account.
    const { id } = await this.createIssueComment(
      pullRequestNumber,
      `${body}\n\n${VIBRATOR_COMMENT_MARKER}`,
    );
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
   * Squash-merges a pull request through the GitHub REST API, passing the
   * provided subject and body as the commit message.
   */
  async squashMergePullRequest(
    pullRequestNumber: number,
    subject: string,
    body: string,
  ): Promise<void> {
    await this.markPullRequestReadyForReview(pullRequestNumber);

    try {
      await this.request(
        `/repos/${this.options.owner}/${this.options.repo}/pulls/${pullRequestNumber}/merge`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commit_title: subject,
            commit_message: body,
            merge_method: "squash",
          }),
        },
      );
    } catch (error) {
      if (isBranchProtectionMergeError(error)) {
        const wrappedError = new Error(
          `GitHub API could not squash-merge PR #${pullRequestNumber}; branch protection may be blocking the merge and the API merge endpoint does not support an administrator-bypass retry.`,
          { cause: error },
        ) as Error & { statusCode?: number };
        const statusCode = (error as Error & { statusCode?: number }).statusCode;
        if (typeof statusCode === "number") {
          wrappedError.statusCode = statusCode;
        }
        throw wrappedError;
      }
      throw error;
    }
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
      const statusCode = (error as Error & { statusCode?: number }).statusCode;
      // Token may lack check-runs access (403) or the ref may not exist (404).
      // Return an empty list so Claude investigates the PR checks itself.
      if (statusCode === 403 || statusCode === 404) {
        return [];
      }
      throw error;
    }
    const allRuns = response.check_runs ?? [];
    const failing = allRuns.filter(
      (run) =>
        run.conclusion === "failure" ||
        run.conclusion === "timed_out" ||
        // Include still-running/queued jobs so Claude knows they were cancelled
        // and can re-trigger them if needed.
        run.status === "in_progress" ||
        run.status === "queued" ||
        run.status === "waiting",
    );
    return failing.map((run) => {
      const summary = run.output?.summary ?? "";
      const text = run.output?.text ?? "";
      const combined = [summary, text].filter(Boolean).join("\n\n");
      const excerpt = combined.length > 4000 ? combined.slice(0, 4000) + "\n…(truncated)" : combined;
      const statusNote =
        run.conclusion === null
          ? `(status: ${run.status ?? "unknown"} — run was cancelled before completing)`
          : "";
      return { name: run.name, logExcerpt: [statusNote, excerpt].filter(Boolean).join("\n") || "(no log excerpt available)" };
    });
  }

  /**
   * Cancel any workflow runs that are still in progress (status:
   * in_progress, queued, or waiting) for the given commit SHA. This is
   * called before Claude tries to address failing/timed-out checks so that
   * the run is definitively finished before new fixes are pushed.
   *
   * Returns the number of runs that were cancelled.
   */
  async cancelInProgressWorkflowRunsForHeadSha(headSha: string): Promise<number> {
    interface WorkflowRunListResponse {
      total_count: number;
      workflow_runs: Array<{ id: number; status: string | null; head_sha: string }>;
    }

    let response: WorkflowRunListResponse;
    try {
      response = await this.request<WorkflowRunListResponse>(
        `/repos/${this.options.owner}/${this.options.repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
      );
    } catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode;
      if (statusCode === 403 || statusCode === 404) {
        return 0;
      }
      throw error;
    }

    const inProgressStatuses = new Set(["in_progress", "queued", "waiting", "requested", "pending"]);
    const toCancel = (response.workflow_runs ?? []).filter(
      (run) => run.status !== null && inProgressStatuses.has(run.status),
    );

    let cancelled = 0;
    for (const run of toCancel) {
      try {
        await this.request<void>(
          `/repos/${this.options.owner}/${this.options.repo}/actions/runs/${run.id}/cancel`,
          { method: "POST" },
        );
        cancelled++;
      } catch {
        // Best-effort: ignore errors (run may have just completed).
      }
    }
    return cancelled;
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

  /**
   * Convert a draft pull request to ready-for-review using the GraphQL mutation.
   * No-op if the PR is already ready.
   */
  async markPullRequestReadyForReview(pullRequestNumber: number): Promise<void> {
    const pr = await this.request<{ node_id: string; draft: boolean }>(
      `/repos/${this.options.owner}/${this.options.repo}/pulls/${pullRequestNumber}`,
    );
    if (!pr.draft) {
      return;
    }
    await this.graphqlRequest(
      `
        mutation MarkPullRequestReadyForReview($prId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $prId }) {
            pullRequest { isDraft }
          }
        }
      `,
      { prId: pr.node_id },
    );
  }

  /**
   * Request review from specific GitHub users on a pull request.
   */
  async requestPullRequestReview(pullRequestNumber: number, reviewers: string[]): Promise<void> {
    if (reviewers.length === 0) return;
    await this.request(
      `/repos/${this.options.owner}/${this.options.repo}/pulls/${pullRequestNumber}/requested_reviewers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewers }),
      },
    );
  }

  /**
   * Ensure a label exists in the repository, creating it if it does not.
   * Silently succeeds if the label already exists.
   */
  async ensureLabelExists(name: string, color: string, description?: string): Promise<void> {
    try {
      await this.request(
        `/repos/${this.options.owner}/${this.options.repo}/labels/${encodeURIComponent(name)}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { statusCode?: number }).statusCode !== 404) {
        throw error;
      }
      await this.request(`/repos/${this.options.owner}/${this.options.repo}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color, description: description ?? "" }),
      });
    }
  }

  /**
   * Cached project metadata: node ID, status field ID, and status option map.
   */
  private projectMetaCache: Map<number, ProjectMeta> | undefined;

  private async getProjectMeta(projectNumber: number): Promise<ProjectMeta> {
    if (!this.projectMetaCache) {
      this.projectMetaCache = new Map();
    }
    const cached = this.projectMetaCache.get(projectNumber);
    if (cached) return cached;

    type QueryResult = {
      repository: {
        projectV2: {
          id: string;
          field: {
            id: string;
            options: Array<{ id: string; name: string }>;
          } | null;
        } | null;
      } | null;
    };

    const data = await this.graphqlRequest<QueryResult>(
      `
        query ProjectMeta($owner: String!, $repo: String!, $projectNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            projectV2(number: $projectNumber) {
              id
              field(name: "Status") {
                ... on ProjectV2SingleSelectField {
                  id
                  options { id name }
                }
              }
            }
          }
        }
      `,
      { owner: this.options.owner, repo: this.options.repo, projectNumber },
    );

    const project = data.repository?.projectV2;
    if (!project) {
      throw new Error(
        `GitHub Project #${projectNumber} not found in ${this.options.owner}/${this.options.repo}`,
      );
    }
    if (!project.field) {
      throw new Error(
        `GitHub Project #${projectNumber} has no "Status" single-select field`,
      );
    }

    const meta: ProjectMeta = {
      id: project.id,
      statusFieldId: project.field.id,
      statusOptions: project.field.options,
    };
    this.projectMetaCache.set(projectNumber, meta);
    return meta;
  }

  /**
   * Fetch the project status for each open issue in the given project.
   * Returns a map of issue number → { itemId, status, statusOptionId }.
   */
  async fetchProjectIssueStatuses(
    projectNumber: number,
  ): Promise<Map<number, { itemId: string; status: string; statusOptionId: string }>> {
    type QueryResult = {
      repository: {
        projectV2: {
          items: {
            nodes: Array<{
              id: string;
              content: { __typename: string; number?: number } | null;
              fieldValueByName: {
                __typename: string;
                name?: string;
                optionId?: string;
              } | null;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } | null;
    };

    const result = new Map<number, { itemId: string; status: string; statusOptionId: string }>();
    let after: string | null = null;

    do {
      const data: QueryResult = await this.graphqlRequest<QueryResult>(
        `
          query ProjectIssueStatuses($owner: String!, $repo: String!, $projectNumber: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              projectV2(number: $projectNumber) {
                items(first: 100, after: $after) {
                  nodes {
                    id
                    content {
                      __typename
                      ... on Issue { number }
                    }
                    fieldValueByName(name: "Status") {
                      __typename
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        optionId
                      }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        `,
        { owner: this.options.owner, repo: this.options.repo, projectNumber, after },
      );

      const projectV2 = data.repository?.projectV2;
      const items = projectV2?.items;
      if (!items) break;

      for (const item of items.nodes) {
        if (item.content?.__typename !== "Issue" || item.content.number === undefined) continue;
        const statusName = item.fieldValueByName?.__typename === "ProjectV2ItemFieldSingleSelectValue"
          ? (item.fieldValueByName.name ?? "")
          : "";
        const statusOptionId = item.fieldValueByName?.__typename === "ProjectV2ItemFieldSingleSelectValue"
          ? (item.fieldValueByName.optionId ?? "")
          : "";
        result.set(item.content.number, {
          itemId: item.id,
          status: statusName,
          statusOptionId,
        });
      }

      after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
    } while (after);

    return result;
  }

  /**
   * Move an issue's status in the GitHub Project to the given status name
   * (e.g. "In Progress", "In Review"). No-ops if the project item or target
   * status option cannot be found.
   */
  async moveIssueToProjectStatus(
    projectNumber: number,
    issueNumber: number,
    targetStatus: string,
  ): Promise<void> {
    let meta: ProjectMeta;
    let statuses: Map<number, { itemId: string; status: string; statusOptionId: string }>;
    try {
      [meta, statuses] = await Promise.all([
        this.getProjectMeta(projectNumber),
        this.fetchProjectIssueStatuses(projectNumber),
      ]);
    } catch (error) {
      console.warn(
        `[vibrator] Could not move issue #${issueNumber} to project status "${targetStatus}": ${String(error)}`,
      );
      return;
    }

    const item = statuses.get(issueNumber);
    if (!item) {
      console.warn(
        `[vibrator] Issue #${issueNumber} is not in project #${projectNumber} — skipping status move.`,
      );
      return;
    }

    const option = meta.statusOptions.find(
      (opt) => opt.name.toLowerCase() === targetStatus.toLowerCase(),
    );
    if (!option) {
      console.warn(
        `[vibrator] Project #${projectNumber} has no status option "${targetStatus}" — skipping status move. ` +
        `Available options: ${meta.statusOptions.map((o) => o.name).join(", ")}`,
      );
      return;
    }

    await this.graphqlRequest(
      `
        mutation UpdateProjectItemStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }) {
            projectV2Item { id }
          }
        }
      `,
      {
        projectId: meta.id,
        itemId: item.itemId,
        fieldId: meta.statusFieldId,
        optionId: option.id,
      },
    );
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
  projectConfig?: { projectNumber: number },
): Promise<RepositorySnapshot> {
  const [issues, pullRequests, agentSessions] = await Promise.all([
    gitHubClient.listOpenIssues(),
    gitHubClient.listOpenPullRequests(),
    sessionStore.load(),
  ]);

  if (!projectConfig) {
    return { issues, pullRequests, agentSessions };
  }

  // Merge project status into issues.
  let projectStatuses: Map<number, { itemId: string; status: string; statusOptionId: string }>;
  try {
    projectStatuses = await gitHubClient.fetchProjectIssueStatuses(projectConfig.projectNumber);
  } catch (error) {
    console.warn(`[vibrator] Could not fetch project statuses: ${String(error)}`);
    projectStatuses = new Map();
  }

  const issuesWithStatus = issues.map((issue) => {
    const entry = projectStatuses.get(issue.number);
    return entry ? { ...issue, projectStatus: entry.status } : issue;
  });

  // For PRs whose latest completed session is `request-review`, check for
  // new human comments since the last-read timestamp.
  const openPullRequests = pullRequests.filter((pr) => pr.state === "open");
  const pullRequestsWithNewComments = await Promise.all(
    openPullRequests.map(async (pr) => {
      const prSessions = agentSessions
        .filter((s) => s.pullRequestNumber === pr.number && s.status === "completed")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      if (prSessions[0]?.phase !== "request-review") {
        return pr;
      }

      const lastReadAt = await sessionStore.getLastReadCommentAt(pr.number);
      if (!lastReadAt) {
        return pr;
      }

      // Quick check: if PR hasn't been updated since the last-read timestamp,
      // skip the full comment fetch.
      if (Date.parse(pr.updatedAt) <= Date.parse(lastReadAt)) {
        return pr;
      }

      try {
        const excludeCommentIds = new Set(await sessionStore.getPostedCommentIds(pr.number));
        const comments = await gitHubClient.listPullRequestComments(pr.number, {
          excludeCommentIds,
        });
        const hasNew = comments.some((c) => Date.parse(c.createdAt) > Date.parse(lastReadAt));
        return hasNew ? { ...pr, hasNewCommentsSinceLastRead: true } : pr;
      } catch {
        return pr;
      }
    }),
  );

  return { issues: issuesWithStatus, pullRequests: pullRequestsWithNewComments, agentSessions };
}

export function buildDefaultSessionStorePath(owner: string, repo: string): string {
  return join(process.cwd(), ".vibrator", `${owner}-${repo}-sessions.json`);
}
