import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { parseLinkedIssueNumbers } from "./orchestrator.js";
import { FileSessionStore } from "./session-store.js";
import type { AgentSession, Issue, PullRequest, RepositorySnapshot } from "./types.js";

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  pull_request?: object;
}

interface GitHubPullRequestResponse {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  created_at: string;
  updated_at: string;
}

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  apiBaseUrl?: string;
}

export class GitHubClient {
  private readonly apiBaseUrl: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
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

    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status} ${response.statusText}) for ${path}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async getAllPages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request<T[]>(
        `${path}${separator}per_page=100&page=${page}`,
      );
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
      }));
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const pullRequests = await this.getAllPages<GitHubPullRequestResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/pulls?state=open`,
    );
    return pullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? "",
      state: pullRequest.state,
      draft: pullRequest.draft,
      createdAt: pullRequest.created_at,
      updatedAt: pullRequest.updated_at,
      linkedIssueNumbers: parseLinkedIssueNumbers(
        `${pullRequest.title}\n${pullRequest.body ?? ""}`,
      ),
    }));
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
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

export async function ensureSessionStoreDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export function buildDefaultSessionStorePath(owner: string, repo: string): string {
  return `${process.cwd()}/.vibrator/${owner}-${repo}-sessions.json`;
}
