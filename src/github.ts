import { join } from "node:path";

import { parseClosingIssueNumbers, parseLinkedIssueNumbers } from "./orchestrator.js";
import { FileSessionStore } from "./session-store.js";
import type { AgentSession, Issue, PullRequest, RepositorySnapshot } from "./types.js";

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
  head: { sha: string };
  state: "open" | "closed";
  draft: boolean;
  created_at: string;
  updated_at: string;
}

interface GitHubPullRequestReviewResponse {
  submitted_at: string | null;
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
    const [pullRequests, closingIssueNumbersByPullRequest] = await Promise.all([
      this.getAllPages<GitHubPullRequestResponse>(
        `/repos/${this.options.owner}/${this.options.repo}/pulls?state=open`,
      ),
      this.fetchOpenPullRequestClosingIssueReferences(),
    ]);

    return pullRequests.map((pullRequest) => {
      const textForRegex = `${pullRequest.title}\n${pullRequest.body ?? ""}`;
      // GitHub's "Development" sidebar / closingIssuesReferences is the
      // authoritative source for which issues a PR closes — PRs opened by
      // the Copilot coding agent often link via the sidebar rather than
      // writing "Fixes #N" in the body. Merge it with any in-body keyword
      // references so we don't miss either source.
      const linkedFromGitHub = closingIssueNumbersByPullRequest.get(pullRequest.number) ?? [];
      const linkedFromBody = parseLinkedIssueNumbers(textForRegex);
      const closingFromBody = parseClosingIssueNumbers(textForRegex);
      const linkedIssueNumbers = mergeSortedUnique(linkedFromGitHub, linkedFromBody);
      const closingIssueNumbers = mergeSortedUnique(linkedFromGitHub, closingFromBody);
      return {
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body ?? "",
        headSha: pullRequest.head.sha,
        state: pullRequest.state,
        draft: pullRequest.draft,
        createdAt: pullRequest.created_at,
        updatedAt: pullRequest.updated_at,
        linkedIssueNumbers,
        closingIssueNumbers,
      };
    });
  }

  private async fetchOpenPullRequestClosingIssueReferences(): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>();
    let after: string | null = null;

    do {
      const data = await this.graphqlRequest<{
        repository: {
          pullRequests: {
            nodes: Array<{
              number: number;
              closingIssuesReferences: { nodes: Array<{ number: number }> } | null;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      }>(
        `
          query OpenPullRequestClosingIssues($owner: String!, $repo: String!, $after: String) {
            repository(owner: $owner, name: $repo) {
              pullRequests(first: 50, states: OPEN, after: $after) {
                nodes {
                  number
                  closingIssuesReferences(first: 50) { nodes { number } }
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
        result.set(node.number, [...new Set(issueNumbers)].sort((left, right) => left - right));
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
  ): Promise<Array<{ submittedAt: string }>> {
    const reviews = await this.getAllPages<GitHubPullRequestReviewResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/pulls/${pullRequestNumber}/reviews`,
    );
    return reviews
      .map((review) => review.submitted_at)
      .filter((submittedAt): submittedAt is string => submittedAt !== null)
      .map((submittedAt) => ({ submittedAt }));
  }

  async countUnresolvedPullRequestReviewThreads(pullRequestNumber: number): Promise<number> {
    return (
      await this.listUnresolvedPullRequestReviewThreadIds(
        pullRequestNumber,
      )
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
