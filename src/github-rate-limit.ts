export type GitHubApiKind = "rest" | "graphql";

export type GitHubRateLimitKind =
  | "primary"
  | "secondary"
  | "abuse"
  | "unknown";

export interface GitHubRateLimitSnapshot {
  observedAtMs: number;
  api: GitHubApiKind;
  resource?: string;
  limit?: number;
  remaining?: number;
  used?: number;
  resetAtMs?: number;
  retryAfterMs?: number;
}

export interface GitHubRateLimitHold {
  kind: GitHubRateLimitKind;
  api: GitHubApiKind;
  resource?: string;
  statusCode?: number;
  blockedUntilMs: number;
  waitMs: number;
  reason: string;
  operation?: string;
  method?: string;
  path?: string;
  attempt: number;
  snapshot?: GitHubRateLimitSnapshot;
}

export class GitHubRateLimitError extends Error {
  readonly kind: GitHubRateLimitKind;
  readonly statusCode: number | undefined;
  readonly blockedUntilMs: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly resetAtMs: number | undefined;
  readonly responseBody: string | undefined;

  constructor(
    message: string,
    options: {
      kind: GitHubRateLimitKind;
      statusCode?: number;
      blockedUntilMs?: number;
      retryAfterMs?: number;
      resetAtMs?: number;
      responseBody?: string;
    },
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.kind = options.kind;
    this.statusCode = options.statusCode;
    this.blockedUntilMs = options.blockedUntilMs;
    this.retryAfterMs = options.retryAfterMs;
    this.resetAtMs = options.resetAtMs;
    this.responseBody = options.responseBody;
  }
}

function parseInteger(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

export function parseRetryAfter(raw: string | null, nowMs: number): number | undefined {
  if (!raw) return undefined;

  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }

  return undefined;
}

export function parseRateLimitSnapshot(
  headers: Headers,
  api: GitHubApiKind,
  observedAtMs: number,
): GitHubRateLimitSnapshot {
  const limit = parseInteger(headers.get("x-ratelimit-limit"));
  const remaining = parseInteger(headers.get("x-ratelimit-remaining"));
  const used = parseInteger(headers.get("x-ratelimit-used"));
  const resetSeconds = parseInteger(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource") ?? undefined;
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), observedAtMs);

  return {
    observedAtMs,
    api,
    ...(resource !== undefined ? { resource } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(resetSeconds !== undefined ? { resetAtMs: resetSeconds * 1000 } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

const SECONDARY_RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /secondary rate limit/i,
  /abuse detection mechanism/i,
  /you have exceeded a secondary rate limit/i,
  /endpoint has been spammed/i,
];

export function isRateLimitGraphQLError(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return false;
  }
  return errors.some((error) => {
    if (!error || typeof error !== "object") return false;
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && /rate limit|secondary rate limit|abuse/i.test(message);
  });
}

export function classifyRateLimitResponse(params: {
  api: GitHubApiKind;
  statusCode: number;
  snapshot: GitHubRateLimitSnapshot;
  responseBody?: string;
  operation?: string;
  method?: string;
  path?: string;
  attempt: number;
  nowMs: number;
  resetSkewMs: number;
  secondaryFallbackWaitMs: number;
  isGraphQLErrorRateLimit?: boolean;
}): GitHubRateLimitHold | undefined {
  const {
    api,
    statusCode,
    snapshot,
    responseBody,
    operation,
    method,
    path,
    attempt,
    nowMs,
    resetSkewMs,
    secondaryFallbackWaitMs,
    isGraphQLErrorRateLimit,
  } = params;

  const statusLooksRateLimited = statusCode === 429;
  const snapshotLooksRateLimited =
    snapshot.remaining === 0 || snapshot.retryAfterMs !== undefined;
  const bodyLooksSecondary =
    typeof responseBody === "string" &&
    SECONDARY_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(responseBody));

  const shouldTreatAsRateLimited =
    statusLooksRateLimited ||
    snapshotLooksRateLimited ||
    bodyLooksSecondary ||
    isGraphQLErrorRateLimit === true;
  if (!shouldTreatAsRateLimited && !bodyLooksSecondary) {
    return undefined;
  }

  if (snapshot.remaining === 0 && snapshot.resetAtMs !== undefined) {
    const blockedUntilMs = snapshot.resetAtMs + resetSkewMs;
    return {
      kind: "primary",
      api,
      ...(snapshot.resource !== undefined ? { resource: snapshot.resource } : {}),
      statusCode,
      blockedUntilMs,
      waitMs: Math.max(0, blockedUntilMs - nowMs),
      reason: `GitHub primary rate limit reached${snapshot.resource ? ` (${snapshot.resource})` : ""}`,
      ...(operation !== undefined ? { operation } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(path !== undefined ? { path } : {}),
      attempt,
      snapshot,
    };
  }

  if (snapshot.retryAfterMs !== undefined) {
    const blockedUntilMs = nowMs + snapshot.retryAfterMs + resetSkewMs;
    return {
      kind: bodyLooksSecondary ? "abuse" : "secondary",
      api,
      ...(snapshot.resource !== undefined ? { resource: snapshot.resource } : {}),
      statusCode,
      blockedUntilMs,
      waitMs: Math.max(0, blockedUntilMs - nowMs),
      reason: "GitHub secondary rate limit signaled Retry-After",
      ...(operation !== undefined ? { operation } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(path !== undefined ? { path } : {}),
      attempt,
      snapshot,
    };
  }

  if (shouldTreatAsRateLimited) {
    if (snapshot.remaining === 0 && snapshot.resetAtMs !== undefined) {
      const blockedUntilMs = snapshot.resetAtMs + resetSkewMs;
      return {
        kind: "secondary",
        api,
        ...(snapshot.resource !== undefined ? { resource: snapshot.resource } : {}),
        statusCode,
        blockedUntilMs,
        waitMs: Math.max(0, blockedUntilMs - nowMs),
        reason: "GitHub rate limit reached; waiting for reset window",
        ...(operation !== undefined ? { operation } : {}),
        ...(method !== undefined ? { method } : {}),
        ...(path !== undefined ? { path } : {}),
        attempt,
        snapshot,
      };
    }

    const exponentialWaitMs = Math.min(
      secondaryFallbackWaitMs * 2 ** Math.max(0, attempt - 1),
      15 * 60 * 1000,
    );
    const blockedUntilMs = nowMs + exponentialWaitMs;
    return {
      kind: bodyLooksSecondary ? "abuse" : "secondary",
      api,
      ...(snapshot.resource !== undefined ? { resource: snapshot.resource } : {}),
      statusCode,
      blockedUntilMs,
      waitMs: exponentialWaitMs,
      reason: "GitHub secondary rate limit detected; applying exponential backoff",
      ...(operation !== undefined ? { operation } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(path !== undefined ? { path } : {}),
      attempt,
      snapshot,
    };
  }

  return undefined;
}
