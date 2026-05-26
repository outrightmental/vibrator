import { globalEventEmitter, type EventEmitter } from "./event-emitter.js";
import {
  broadcastGitHubRateLimit,
  broadcastGitHubRateLimitCleared,
} from "./dashboard-utils.js";
import {
  classifyRateLimitResponse,
  GitHubRateLimitError,
  isRateLimitGraphQLError,
  parseRateLimitSnapshot,
  type GitHubApiKind,
  type GitHubRateLimitHold,
  type GitHubRateLimitSnapshot,
} from "./github-rate-limit.js";

export interface GitHubApiGatewayOptions {
  token: string;
  apiBaseUrl?: string;
  userAgent?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  eventEmitter?: EventEmitter;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  mutativeSpacingMs?: number;
  maxAttempts?: number;
  secondaryFallbackWaitMs?: number;
  resetSkewMs?: number;
}

export interface GitHubRequestOptions extends RequestInit {
  operation?: string;
  retryOnRateLimit?: boolean;
}

interface GraphQLPayload<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  const parts = linkHeader.split(",").map((part) => part.trim());
  for (const part of parts) {
    const match = part.match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match && match[2] === "next") {
      return match[1];
    }
  }
  return undefined;
}

function withPerPage(path: string): string {
  if (/([?&])per_page=/.test(path)) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}per_page=100`;
}

function isMutativeHttpMethod(method: string | undefined): boolean {
  if (!method) return false;
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase());
}

function isGraphQLMutation(query: string): boolean {
  return /^\s*mutation\b/i.test(query);
}

function toErrorWithStatus(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function headersToObject(headers: Headers): Record<string, string> {
  const raw = Object.fromEntries(headers.entries());
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "authorization") mapped.Authorization = value;
    else if (key === "accept") mapped.Accept = value;
    else if (key === "content-type") mapped["Content-Type"] = value;
    else if (key === "user-agent") mapped["User-Agent"] = value;
    else if (key === "x-github-api-version") mapped["X-GitHub-Api-Version"] = value;
    else mapped[key] = value;
  }
  return mapped;
}

export class GitHubApiGateway {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly userAgent: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly eventEmitter: EventEmitter;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mutativeSpacingMs: number;
  private readonly maxAttempts: number;
  private readonly secondaryFallbackWaitMs: number;
  private readonly resetSkewMs: number;

  private latestSnapshotByResource = new Map<string, GitHubRateLimitSnapshot>();
  private activeHold: GitHubRateLimitHold | undefined;
  private lastMutativeRequestAtMs = 0;
  private queueTail: Promise<unknown> = Promise.resolve();
  private wasHolding = false;

  constructor(options: GitHubApiGatewayOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.token = options.token;
    this.userAgent = options.userAgent ?? "vibrator";
    this.apiVersion = options.apiVersion ?? "2022-11-28";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.eventEmitter = options.eventEmitter ?? globalEventEmitter;
    this.clock = options.clock ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.mutativeSpacingMs = options.mutativeSpacingMs ?? 1100;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.secondaryFallbackWaitMs = options.secondaryFallbackWaitMs ?? 60_000;
    this.resetSkewMs = options.resetSkewMs ?? 5_000;
  }

  request<T>(path: string, init: GitHubRequestOptions = {}): Promise<T> {
    return this.enqueue(async () => {
      const { data } = await this.requestWithRetry<T>(path, init);
      return data;
    });
  }

  graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    options: { operation?: string; retryOnRateLimit?: boolean } = {},
  ): Promise<T> {
    return this.enqueue(() => this.graphqlWithRetry<T>(query, variables, options));
  }

  getAllPages<T>(path: string, init: GitHubRequestOptions = {}): Promise<T[]> {
    return this.enqueue(async () => {
      const results: T[] = [];
      let nextPath: string | undefined = withPerPage(path);
      while (nextPath) {
        const { data, headers } = await this.requestWithRetry<T[]>(nextPath, init);
        results.push(...data);
        nextPath = parseNextLink(headers.get("link"));
      }
      return results;
    });
  }

  currentRateLimitHold(): GitHubRateLimitHold | undefined {
    this.clearHoldIfExpired();
    if (!this.activeHold) return undefined;
    return this.clock() < this.activeHold.blockedUntilMs ? this.activeHold : undefined;
  }

  async waitUntilReady(): Promise<void> {
    while (this.activeHold && this.clock() < this.activeHold.blockedUntilMs) {
      await this.sleep(this.activeHold.blockedUntilMs - this.clock());
    }
    this.clearHoldIfExpired();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(task, task);
    this.queueTail = run.catch(() => undefined);
    return run;
  }

  private clearHoldIfExpired(): void {
    if (!this.activeHold) return;
    if (this.clock() < this.activeHold.blockedUntilMs) return;
    this.activeHold = undefined;
    if (this.wasHolding) {
      this.wasHolding = false;
      if (this.eventEmitter === globalEventEmitter) {
        broadcastGitHubRateLimitCleared();
      } else {
        this.eventEmitter.emit("github-rate-limit-cleared", {});
      }
    }
  }

  private registerSnapshot(snapshot: GitHubRateLimitSnapshot): void {
    if (snapshot.resource) {
      this.latestSnapshotByResource.set(snapshot.resource, snapshot);
    }
  }

  private async waitForMutativeSpacingIfNeeded(isMutative: boolean): Promise<void> {
    if (!isMutative) return;
    const now = this.clock();
    const elapsed = now - this.lastMutativeRequestAtMs;
    if (elapsed < this.mutativeSpacingMs) {
      await this.sleep(this.mutativeSpacingMs - elapsed);
    }
    this.lastMutativeRequestAtMs = this.clock();
  }

  private buildRequestHeaders(initHeaders: HeadersInit | undefined, includeJsonContentType: boolean): Headers {
    const headers = new Headers(initHeaders);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/vnd.github+json");
    }
    if (!headers.has("Authorization")) {
      headers.set("Authorization", "Bearer".concat(" ", this.token));
    }
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", this.userAgent);
    }
    if (!headers.has("X-GitHub-Api-Version")) {
      headers.set("X-GitHub-Api-Version", this.apiVersion);
    }
    if (includeJsonContentType && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return headers;
  }

  private resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    return `${this.apiBaseUrl}${path}`;
  }

  private applyHold(hold: GitHubRateLimitHold): void {
    if (!this.activeHold || hold.blockedUntilMs >= this.activeHold.blockedUntilMs) {
      this.activeHold = hold;
    }
    this.wasHolding = true;
    if (this.eventEmitter === globalEventEmitter) {
      broadcastGitHubRateLimit(hold);
      return;
    }
    this.eventEmitter.emit("github-rate-limit", {
      kind: hold.kind,
      api: hold.api,
      resource: hold.resource ?? null,
      statusCode: hold.statusCode ?? null,
      blockedUntilMs: hold.blockedUntilMs,
      waitMs: hold.waitMs,
      resetAtMs: hold.snapshot?.resetAtMs ?? null,
      retryAfterMs: hold.snapshot?.retryAfterMs ?? null,
      limit: hold.snapshot?.limit ?? null,
      remaining: hold.snapshot?.remaining ?? null,
      used: hold.snapshot?.used ?? null,
      operation: hold.operation ?? null,
      method: hold.method ?? null,
      path: hold.path ?? null,
      attempt: hold.attempt,
      message: hold.reason,
    });
  }

  private async parseJsonOrUndefined<T>(response: Response, textBody: string): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }
    if (textBody.length === 0) {
      return undefined as T;
    }
    return JSON.parse(textBody) as T;
  }

  private async requestWithRetry<T>(
    path: string,
    init: GitHubRequestOptions,
  ): Promise<{ data: T; headers: Headers }> {
    const method = (init.method ?? "GET").toUpperCase();
    const retryOnRateLimit = init.retryOnRateLimit ?? true;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.waitUntilReady();
      await this.waitForMutativeSpacingIfNeeded(isMutativeHttpMethod(method));

      const includeJsonContentType = typeof init.body === "string";
      const response = await this.fetchImpl(this.resolveUrl(path), {
        ...init,
        ...(init.method !== undefined ? { method } : {}),
        headers: headersToObject(this.buildRequestHeaders(init.headers, includeJsonContentType)),
      });

      const observedAtMs = this.clock();
      const snapshot = parseRateLimitSnapshot(response.headers, "rest", observedAtMs);
      this.registerSnapshot(snapshot);

      let responseBody = "";
      try {
        responseBody = await response.text();
      } catch {
        responseBody = "";
      }

      const hold = classifyRateLimitResponse({
        api: "rest",
        statusCode: response.status,
        snapshot,
        responseBody,
        method,
        path,
        attempt,
        nowMs: observedAtMs,
        resetSkewMs: this.resetSkewMs,
        secondaryFallbackWaitMs: this.secondaryFallbackWaitMs,
        ...(init.operation !== undefined ? { operation: init.operation } : {}),
      });

      if (hold) {
        if (retryOnRateLimit && attempt < this.maxAttempts) {
          this.applyHold(hold);
          await this.waitUntilReady();
          continue;
        }
        throw new GitHubRateLimitError(
          `GitHub API rate limit encountered for ${path}`,
          {
            kind: hold.kind,
            ...(response.status !== undefined ? { statusCode: response.status } : {}),
            ...(hold.blockedUntilMs !== undefined ? { blockedUntilMs: hold.blockedUntilMs } : {}),
            ...(snapshot.retryAfterMs !== undefined ? { retryAfterMs: snapshot.retryAfterMs } : {}),
            ...(snapshot.resetAtMs !== undefined ? { resetAtMs: snapshot.resetAtMs } : {}),
            ...(responseBody !== undefined ? { responseBody } : {}),
          },
        );
      }

      if (response.status === 404) {
        throw toErrorWithStatus(`GitHub request failed (404 Not Found) for ${path}`, 404);
      }
      if (response.status === 403) {
        throw toErrorWithStatus(`GitHub request failed (403 Forbidden) for ${path}`, 403);
      }

      if (!response.ok) {
        console.error(
          `[vibrator] GitHub ${response.status} ${response.statusText} for ${path}. Response body:\n${responseBody || "(empty)"}`,
        );
        throw toErrorWithStatus(
          `GitHub request failed (${response.status} ${response.statusText}) for ${path}. Response body: ${responseBody || "(empty)"}`,
          response.status,
        );
      }

      const data = await this.parseJsonOrUndefined<T>(response, responseBody);
      return { data, headers: response.headers };
    }

    throw new GitHubRateLimitError(`GitHub API rate limit encountered for ${path}`, {
      kind: "unknown",
    });
  }

  private async graphqlWithRetry<T>(
    query: string,
    variables: Record<string, unknown>,
    options: { operation?: string; retryOnRateLimit?: boolean },
  ): Promise<T> {
    const retryOnRateLimit = options.retryOnRateLimit ?? true;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.waitUntilReady();
      await this.waitForMutativeSpacingIfNeeded(isGraphQLMutation(query));

      const response = await this.fetchImpl(this.resolveUrl("/graphql"), {
        method: "POST",
        headers: headersToObject(this.buildRequestHeaders(undefined, true)),
        body: JSON.stringify({ query, variables }),
      });

      const observedAtMs = this.clock();
      const snapshot = parseRateLimitSnapshot(response.headers, "graphql", observedAtMs);
      this.registerSnapshot(snapshot);

      let responseBody = "";
      try {
        responseBody = await response.text();
      } catch {
        responseBody = "";
      }

      const baseHold = classifyRateLimitResponse({
        api: "graphql",
        statusCode: response.status,
        snapshot,
        responseBody,
        method: "POST",
        path: "/graphql",
        attempt,
        nowMs: observedAtMs,
        resetSkewMs: this.resetSkewMs,
        secondaryFallbackWaitMs: this.secondaryFallbackWaitMs,
        ...(options.operation !== undefined ? { operation: options.operation } : {}),
      });

      let payload: GraphQLPayload<T> | undefined;
      if (responseBody) {
        try {
          payload = JSON.parse(responseBody) as GraphQLPayload<T>;
        } catch {
          payload = undefined;
        }
      }

      const graphQLErrorRateLimited =
        (payload !== undefined && isRateLimitGraphQLError(payload)) ||
        (payload !== undefined && Array.isArray(payload.errors) && payload.errors.length > 0 && snapshot.remaining === 0);

      const hold =
        baseHold ??
        (graphQLErrorRateLimited
          ? classifyRateLimitResponse({
              api: "graphql",
              statusCode: response.status,
              snapshot,
              responseBody,
              method: "POST",
              path: "/graphql",
              attempt,
              nowMs: observedAtMs,
              resetSkewMs: this.resetSkewMs,
              secondaryFallbackWaitMs: this.secondaryFallbackWaitMs,
              isGraphQLErrorRateLimit: true,
              ...(options.operation !== undefined ? { operation: options.operation } : {}),
            })
          : undefined);

      if (hold) {
        if (retryOnRateLimit && attempt < this.maxAttempts) {
          this.applyHold(hold);
          await this.waitUntilReady();
          continue;
        }
        throw new GitHubRateLimitError("GitHub GraphQL rate limit encountered", {
          kind: hold.kind,
          ...(response.status !== undefined ? { statusCode: response.status } : {}),
          ...(hold.blockedUntilMs !== undefined ? { blockedUntilMs: hold.blockedUntilMs } : {}),
          ...(snapshot.retryAfterMs !== undefined ? { retryAfterMs: snapshot.retryAfterMs } : {}),
          ...(snapshot.resetAtMs !== undefined ? { resetAtMs: snapshot.resetAtMs } : {}),
          ...(responseBody !== undefined ? { responseBody } : {}),
        });
      }

      if (!response.ok) {
        throw new Error(`GitHub request failed (${response.status} ${response.statusText}) for /graphql`);
      }

      if (!payload) {
        throw new Error("GitHub GraphQL request failed: Invalid JSON response");
      }

      if (!payload.data) {
        const messages = payload.errors?.map((error) => error.message).join("; ") ?? "Unknown GraphQL error";
        throw new Error(`GitHub GraphQL request failed: ${messages}`);
      }

      return payload.data;
    }

    throw new GitHubRateLimitError("GitHub GraphQL rate limit encountered", { kind: "unknown" });
  }
}

export type {
  GitHubApiKind,
  GitHubRateLimitHold,
  GitHubRateLimitSnapshot,
} from "./github-rate-limit.js";
