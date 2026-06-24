import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import { executeAction, type ExecuteActionResult } from "./actions.js";
import {
  createClaudeAgentClient,
  DEFAULT_COMMIT_MODEL,
  isClaudeUsageLimitMessage,
  getClaudeQuotaBlockedUntilMs,
} from "./claude-agent.js";
import { loadEnvConfig, resolveGitHubToken, applyProjectDefaults, type EnvConfig, type ProjectEnvConfig } from "./env-config.js";
import {
  buildDefaultSessionStorePath,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { GitHubApiGateway } from "./github-gateway.js";
import { buildPlan, FOCUS_LABEL, type ProjectModeConfig } from "./orchestrator.js";
import {
  repoActionKey,
  claimsForRepo,
  claimedImplementationIssueNumbers,
  tryClaimFromPlan,
} from "./scheduler.js";
import { reconcileSessions } from "./reconcile.js";
import { FileSessionStore } from "./session-store.js";
import { DashboardServer } from "./dashboard-server.js";
import { resolveDashboardTitle } from "./dashboard-title.js";
import { globalEventEmitter, EventEmitter } from "./event-emitter.js";
import {
  broadcastRepositorySnapshot,
  broadcastPullRequestUpdate,
  broadcastIssueUpdate,
  broadcastCommit,
  broadcastReviewComment,
  broadcastLifecycleUpdate,
  emitLogMessage,
  hasPrStateChanged,
  filterNewCommits,
} from "./dashboard-utils.js";
import type {
  AgentSession,
  OrchestratorAction,
  RepositorySnapshot,
} from "./types.js";

const RULE = "─".repeat(80);
const HEAVY_RULE = "═".repeat(80);

/**
 * How long a project's snapshot may be reused across engine planning passes
 * before it is reloaded. Several engines plan in quick succession under the
 * shared planning mutex; this lets them reuse one fetch instead of each hitting
 * GitHub. Kept short so freshly-completed work disappears from plans quickly.
 */
const SNAPSHOT_FRESH_MS = 8000;

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function write(line: string): void {
  console.log(line);
  emitLogMessage("info", line);
}

function blank(): void {
  console.log("");
}

function createLogger(emitter: EventEmitter, repo = "") {
  function write(line: string): void {
    console.log(line);
    emitLogMessage("info", line, emitter, repo);
  }
  function blank(): void { console.log(""); }
  function section(title: string): void { blank(); write(title); write(RULE); }
  function bullet(text: string, indent = 1): void { write(`${"  ".repeat(indent)}• ${text}`); }
  function note(text: string, indent = 1): void { write(`${"  ".repeat(indent)}${text}`); }
  return { write, blank, section, bullet, note };
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Serialises planning across all engines to prevent double-booking. */
class PlanningMutex {
  private locked = false;
  private waiting: Array<() => void> = [];

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.locked = true;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    }
  }
}

interface PollingState {
  lastPolledAt: number;
  lastSnapshot: RepositorySnapshot | null;
  seenCommitHashes: Set<string>;
}

/**
 * Per-project runtime: the GitHub/Claude clients, session store, polling state,
 * concurrency cap, and a short-lived snapshot cache shared across the engine
 * pool. One exists per configured project; the shared engine pool roams across
 * all of them.
 */
interface ProjectContext {
  config: Config;
  /** "owner/repo" — the project identity shown on every dashboard element. */
  repoKey: string;
  githubGateway: GitHubApiGateway;
  githubToken: string;
  gitHubClient: GitHubClient;
  sessionStore: FileSessionStore;
  claudeAgentClient: ReturnType<typeof createClaudeAgentClient>;
  pollingState: PollingState;
  /** Cap on how many of the shared cylinders may work this project at once. */
  cap: number;
  snapshotCache: { snapshot: RepositorySnapshot; atMs: number } | null;
  lastMaintenanceAtMs: number;
}

async function loadProjectSnapshot(ctx: ProjectContext): Promise<RepositorySnapshot> {
  return loadSnapshot(
    ctx.gitHubClient,
    ctx.sessionStore,
    ctx.config.projectMode ? { projectNumber: ctx.config.projectMode.projectNumber } : undefined,
  );
}

/** Returns a recent snapshot, reusing the cache while it is still fresh. */
async function getProjectSnapshot(ctx: ProjectContext): Promise<RepositorySnapshot> {
  const now = Date.now();
  if (ctx.snapshotCache && now - ctx.snapshotCache.atMs < SNAPSHOT_FRESH_MS) {
    return ctx.snapshotCache.snapshot;
  }
  const snapshot = await loadProjectSnapshot(ctx);
  ctx.snapshotCache = { snapshot, atMs: now };
  return snapshot;
}

async function broadcastBetweenCycleActivity(
  ctx: ProjectContext,
  claimedActions: ReadonlySet<string>,
  emitter: EventEmitter,
): Promise<void> {
  const { config, pollingState } = ctx;
  const repoKey = ctx.repoKey;
  try {
    const snapshot = await loadProjectSnapshot(ctx);
    ctx.snapshotCache = { snapshot, atMs: Date.now() };
    const lastSnapshot = pollingState.lastSnapshot;

    const lastPrMap = lastSnapshot
      ? new Map(lastSnapshot.pullRequests.map((p) => [p.number, p]))
      : null;
    const snapshotChanged = !lastSnapshot ||
      lastSnapshot.issues.length !== snapshot.issues.length ||
      lastSnapshot.pullRequests.length !== snapshot.pullRequests.length ||
      lastSnapshot.agentSessions.filter((s) => s.status === "in_progress").length !==
        snapshot.agentSessions.filter((s) => s.status === "in_progress").length;
    if (snapshotChanged) {
      broadcastRepositorySnapshot(snapshot, config.owner, config.repo, undefined, emitter);
    }
    const { blockedIssueNumbers } = buildPlan(snapshot, ctx.cap, config.projectMode, config.focusMode);
    broadcastLifecycleUpdate(
      snapshot,
      claimedImplementationIssueNumbers(claimedActions, repoKey),
      new Set(),
      blockedIssueNumbers,
      config.projectMode !== undefined,
      config.focusMode,
      emitter,
      repoKey,
    );

    for (const pr of snapshot.pullRequests.filter((p) => p.state === "open")) {
      const lastPr = lastPrMap?.get(pr.number);
      const prChanged = !lastPr || hasPrStateChanged(pr, lastPr);
      if (prChanged) {
        broadcastPullRequestUpdate(pr, "monitoring", undefined, emitter, repoKey);
      }
      const reviewCountChanged = !lastPr ||
        lastPr.unresolvedReviewCommentCount !== pr.unresolvedReviewCommentCount;
      if (reviewCountChanged) {
        try {
          const reviewComments = await ctx.gitHubClient.listUnresolvedReviewComments(pr.number);
          if (reviewComments.length > 0) {
            broadcastReviewComment(pr.number, "Review", reviewComments.length, undefined, emitter, repoKey);
          }
        } catch {
          // Silently skip review comment broadcasting if it fails
        }
      }
    }

    if (lastSnapshot) {
      const lastIssueMap = new Map(lastSnapshot.issues.map((i) => [i.number, i]));
      for (const issue of snapshot.issues) {
        const lastIssue = lastIssueMap.get(issue.number);
        if (!lastIssue || new Date(issue.updatedAt) > new Date(lastIssue.updatedAt)) {
          broadcastIssueUpdate(issue, lastIssue ? "updated" : "opened", undefined, emitter, repoKey);
        }
      }
    }

    const newSeenHashes = new Set(pollingState.seenCommitHashes);
    try {
      const recentCommits = await ctx.gitHubClient.listRecentCommits(5);
      for (const commit of filterNewCommits(recentCommits, pollingState.seenCommitHashes)) {
        broadcastCommit(commit, undefined, emitter, repoKey);
        newSeenHashes.add(commit.hash);
      }
    } catch {
      // Silently skip commit broadcasting if it fails
    }

    pollingState.lastSnapshot = snapshot;
    pollingState.seenCommitHashes = newSeenHashes;
  } catch {
    // Silently fail on between-cycle polling errors
  }
}

function describeAction(
  action: OrchestratorAction,
  snapshot: RepositorySnapshot,
  gitHubClient: GitHubClient,
): string {
  const actionIssueNumber =
    action.type === "start-implementation" ? action.issueNumber : action.issueNumber;
  const issueTitle =
    actionIssueNumber !== undefined
      ? snapshot.issues.find((i) => i.number === actionIssueNumber)?.title
      : undefined;
  const issueSuffix = issueTitle ? ` "${issueTitle}"` : "";
  const issueContext =
    actionIssueNumber !== undefined
      ? ` (issue #${actionIssueNumber}${issueSuffix})`
      : " (no linked issue)";
  switch (action.type) {
    case "start-implementation":
      return `Implement issue #${action.issueNumber}${issueSuffix} via Claude (${gitHubClient.issueUrl(action.issueNumber)})`;
    case "self-review":
      return `Self-review PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "address-failing-checks":
      return `Address failing status checks on PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "squash-merge":
      return `Squash-merge PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "resolve-conflicts":
      return `Resolve merge conflicts in PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "request-review":
      return `Request human review on PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
  }
}

function describeSession(
  session: AgentSession,
  gitHubClient: GitHubClient,
): string {
  const target =
    session.pullRequestNumber !== undefined
      ? `PR #${session.pullRequestNumber} (${gitHubClient.pullRequestUrl(session.pullRequestNumber)})`
      : session.issueNumber !== undefined
        ? `issue #${session.issueNumber} (${gitHubClient.issueUrl(session.issueNumber)})`
        : "(no linked issue or PR)";
  return `${session.phase} · ${session.status} · ${target} · session ${shortId(session.id)}`;
}

interface Config {
  owner: string;
  repo: string;
  claudeModel: string | undefined;
  /** Model used for commit message generation. Defaults to claude-haiku when unset. */
  claudeCommitModel: string | undefined;
  /** Per-project concurrency cap (a subset of the global pool). */
  maxConcurrency: number;
  cycleMinimumMs: number;
  once: boolean;
  dryRun: boolean;
  noBrowser: boolean;
  sessionStorePath: string;
  /** Human-in-the-Loop project mode config. Undefined = standard auto-merge mode. */
  projectMode: ProjectModeConfig | undefined;
  /** Focus mode: when true, only issues labelled "focus" are picked up. */
  focusMode: boolean;
}

function parseRepositorySlug(repository: string): { owner: string; repo: string } {
  const match = repository.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Invalid repository slug "${repository}". Expected "owner/repo".`);
  }
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug "${repository}". Expected "owner/repo".`);
  }
  return { owner, repo };
}

function buildProjectConfig(
  projectEnvConfig: ProjectEnvConfig,
  envConfig: EnvConfig,
  runtimeFlags: { once: boolean; dryRun: boolean; noBrowser: boolean },
): Config {
  const { owner, repo } = parseRepositorySlug(projectEnvConfig.github_repository);
  const resolved = applyProjectDefaults(projectEnvConfig, envConfig);

  const projectNumber = projectEnvConfig.github_project_number;
  const projectMode: ProjectModeConfig | undefined =
    projectNumber !== undefined ? { projectNumber, reviewers: resolved.reviewers } : undefined;

  const sessionStorePath =
    projectEnvConfig.session_store_path ?? buildDefaultSessionStorePath(owner, repo);

  return {
    owner,
    repo,
    claudeModel: resolved.claude_code_model,
    claudeCommitModel: resolved.claude_describe_model,
    maxConcurrency: resolved.max_concurrency,
    cycleMinimumMs: Math.round(resolved.cycle_minimum_seconds * 1000),
    once: runtimeFlags.once,
    dryRun: runtimeFlags.dryRun,
    noBrowser: runtimeFlags.noBrowser,
    sessionStorePath,
    projectMode,
    focusMode: resolved.focus_mode,
  };
}

/**
 * Per-project, once-per-cycle housekeeping: approve pending workflow runs,
 * reconcile stale sessions, and refresh the dashboard's snapshot/PR/lifecycle
 * panes. Run by engine 0 only (outside the planning mutex) so it never blocks
 * the rest of the pool from picking up work.
 */
async function runProjectMaintenance(
  ctx: ProjectContext,
  claimedActions: ReadonlySet<string>,
  emitter: EventEmitter,
): Promise<void> {
  const { config } = ctx;
  const repoKey = ctx.repoKey;
  const { section, bullet, note } = createLogger(emitter, repoKey);

  section(`${repoKey}: Workflow approvals`);
  try {
    note("looking up workflow runs awaiting maintainer approval…");
    const pendingRuns = await ctx.gitHubClient.listWorkflowRunsAwaitingApproval();
    if (pendingRuns.length === 0) {
      bullet("0 runs awaiting maintainer approval");
    } else {
      bullet(`${pendingRuns.length} run(s) awaiting maintainer approval`);
      for (const run of pendingRuns) {
        const label = `run ${run.id} "${run.name || "unnamed"}" [status=${run.status}, event=${run.event}, branch=${run.headBranch || "?"}] (${run.htmlUrl})`;
        if (config.dryRun) {
          note(`→ [dry-run] would approve ${label}`, 2);
          continue;
        }
        note(`→ approving ${label}…`, 2);
        try {
          const result = await ctx.gitHubClient.approveWorkflowRun(run.id);
          note(result.approved ? `✓ approved ${label}` : `skipped ${label}: ${result.reason}`, 2);
          emitter.emit("workflow-approval", {
            runId: run.id,
            runName: run.name,
            approved: result.approved,
            repo: repoKey,
          });
        } catch (error) {
          note(`✗ failed to approve ${label}: ${(error as Error).message}`, 2);
        }
      }
    }
  } catch (error) {
    bullet(`failed to list workflow runs awaiting approval: ${(error as Error).message}`);
  }

  section(`${repoKey}: Snapshot`);
  note("loading issues, pull requests, and agent sessions from GitHub…");
  const snapshot = await loadProjectSnapshot(ctx);
  const openPullRequests = snapshot.pullRequests.filter((p) => p.state === "open");
  bullet(
    `${snapshot.issues.length} open issue(s), ${openPullRequests.length} open pull request(s), ${snapshot.agentSessions.filter((s) => s.status === "in_progress").length} active session(s)`,
  );

  section(`${repoKey}: Reconciliation`);
  note("checking for stale in-progress sessions…");
  const reconcileEvents = await reconcileSessions(ctx.sessionStore, snapshot.agentSessions);
  bullet(`${reconcileEvents.length} stale session(s) failed`);
  for (const event of reconcileEvents) {
    note(`◦ ${describeSession(event.session, ctx.gitHubClient)}`, 2);
  }
  snapshot.agentSessions = await ctx.sessionStore.load();
  ctx.snapshotCache = { snapshot, atMs: Date.now() };

  const activeSessions = snapshot.agentSessions.filter((s) => s.status === "in_progress");
  emitter.emit("snapshot-update", {
    repo: repoKey,
    issueCount: snapshot.issues.length,
    prCount: openPullRequests.length,
    draftPrCount: openPullRequests.filter((pr) => pr.draft).length,
    readyPrCount: openPullRequests.filter((pr) => !pr.draft).length,
    sessionCount: activeSessions.length,
    issues: snapshot.issues.map((i) => ({ number: i.number, title: i.title, state: i.state })),
    pullRequests: openPullRequests.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      checksStatus: pr.checksStatus,
      closingIssueNumbers: pr.closingIssueNumbers,
      linkedIssueNumbers: pr.linkedIssueNumbers,
    })),
  });

  broadcastRepositorySnapshot(snapshot, config.owner, config.repo, activeSessions.length, emitter);
  for (const pr of openPullRequests) {
    const draftLabel = pr.draft ? "[DRAFT]" : "";
    const checksLabel = pr.checksStatus === "success" ? "[CHECKS OK]" : "[CHECKS " + pr.checksStatus.toUpperCase() + "]";
    broadcastPullRequestUpdate(pr, `tracking ${draftLabel} ${checksLabel}`, undefined, emitter, repoKey);
  }

  const plan = buildPlan(snapshot, ctx.cap, config.projectMode, config.focusMode);
  broadcastLifecycleUpdate(
    snapshot,
    claimedImplementationIssueNumbers(claimedActions, repoKey),
    new Set(),
    plan.blockedIssueNumbers,
    config.projectMode !== undefined,
    config.focusMode,
    emitter,
    repoKey,
  );
}

interface PlannedWork {
  ctx: ProjectContext;
  action: OrchestratorAction;
  snapshot: RepositorySnapshot;
  blockedIssueNumbers: Record<number, number[]>;
}

/**
 * Scan every project (in configured order) for the first claimable action,
 * honouring each project's concurrency cap. Runs under the planning mutex so
 * the claim it makes is visible to the next engine before it plans.
 */
async function planNextAction(
  contexts: ProjectContext[],
  claimedActions: Set<string>,
  emitter: EventEmitter,
): Promise<PlannedWork | null> {
  for (const ctx of contexts) {
    // Respect the per-project cap: never let more than `cap` of the shared
    // cylinders work the same project at once.
    if (claimsForRepo(claimedActions, ctx.repoKey) >= ctx.cap) {
      continue;
    }

    let snapshot: RepositorySnapshot;
    try {
      snapshot = await getProjectSnapshot(ctx);
    } catch {
      continue;
    }
    const plan = buildPlan(snapshot, ctx.cap, ctx.config.projectMode, ctx.config.focusMode);

    const claimed = tryClaimFromPlan(ctx.repoKey, ctx.cap, plan.actions, claimedActions);

    // Refresh this project's lifecycle pane on every planning pass so pills
    // reflect the freshest snapshot (and any claim we just made).
    broadcastLifecycleUpdate(
      snapshot,
      claimedImplementationIssueNumbers(claimedActions, ctx.repoKey),
      new Set(),
      plan.blockedIssueNumbers,
      ctx.config.projectMode !== undefined,
      ctx.config.focusMode,
      emitter,
      ctx.repoKey,
    );

    if (claimed) {
      return { ctx, action: claimed, snapshot, blockedIssueNumbers: plan.blockedIssueNumbers };
    }
  }
  return null;
}

async function runEngine(
  engineIndex: number,
  contexts: ProjectContext[],
  globalMaxConcurrency: number,
  globalCycleMinimumMs: number,
  planningMutex: PlanningMutex,
  claimedActions: Set<string>,
  shutdownSignal: { requested: boolean },
  cancelSignal: { requested: boolean },
  emitter: EventEmitter,
): Promise<void> {
  const { write, blank, section, bullet, note } = createLogger(emitter);
  const isOnceMode = contexts[0]?.config.once ?? false;
  let iterationNumber = 0;

  do {
    if (shutdownSignal.requested) {
      emitter.emit("engine-shutdown", { engineIndex });
      write(`Engine ${engineIndex + 1}: shutdown — no further work will be done.`);
      return;
    }

    cancelSignal.requested = false;
    const cycleStart = Date.now();
    iterationNumber++;

    // GitHub rate-limit holds are per-gateway (per project). Pause this engine
    // while ANY project's gateway is on hold.
    const heldCtx = contexts.find((c) => {
      const hold = c.githubGateway.currentRateLimitHold();
      return hold && Date.now() < hold.blockedUntilMs;
    });
    if (heldCtx) {
      const hold = heldCtx.githubGateway.currentRateLimitHold()!;
      emitter.emit("engine-idle", {
        engineIndex,
        reason: "github-rate-limit",
        rateLimitedUntilMs: hold.blockedUntilMs,
        nextCycleAtMs: hold.blockedUntilMs,
      });
      await heldCtx.githubGateway.waitUntilReady();
      continue;
    }

    emitter.emit("iteration-start", {
      iterationNumber,
      engineIndex,
      maxConcurrency: globalMaxConcurrency,
    });

    // ── Per-project maintenance (engine 0 only, outside the mutex) ──────────
    if (engineIndex === 0) {
      for (const ctx of contexts) {
        if (Date.now() - ctx.lastMaintenanceAtMs < ctx.config.cycleMinimumMs) continue;
        ctx.lastMaintenanceAtMs = Date.now();
        try {
          await runProjectMaintenance(ctx, claimedActions, emitter);
        } catch (error) {
          bullet(`${ctx.repoKey}: maintenance failed: ${(error as Error).message}`);
        }
      }
    }

    // ── Planning phase (serialised via the shared mutex) ────────────────────
    const planned = await planningMutex.withLock(() =>
      planNextAction(contexts, claimedActions, emitter),
    );

    // ── Execution phase ─────────────────────────────────────────────────────
    let cycleRateLimitedUntilMs: number | undefined;
    if (planned) {
      const { ctx, action, snapshot, blockedIssueNumbers } = planned;
      const { config } = ctx;

      section(`Engine ${engineIndex + 1} · ${ctx.repoKey}: Action`);
      bullet(describeAction(action, snapshot, ctx.gitHubClient));

      emitter.emit("phase-update", { phase: "implementation" });
      emitter.emit("action-start", {
        actionIndex: engineIndex + 1,
        totalActions: globalMaxConcurrency,
        repo: ctx.repoKey,
        description: describeAction(action, snapshot, ctx.gitHubClient),
        type: action.type,
        issueNumber: action.issueNumber ?? null,
        pullRequestNumber:
          action.type !== "start-implementation" ? action.pullRequestNumber : null,
        model: action.type === "squash-merge"
          ? (config.claudeCommitModel ?? DEFAULT_COMMIT_MODEL)
          : (config.claudeModel ?? null),
        startedAt: Date.now(),
      });

      const actionContext = {
        owner: config.owner,
        repo: config.repo,
        issues: snapshot.issues,
        pullRequests: snapshot.pullRequests,
        ...(config.projectMode ? { projectMode: config.projectMode } : {}),
      };

      try {
        const result: ExecuteActionResult = await executeAction(
          ctx.gitHubClient,
          ctx.sessionStore,
          ctx.claudeAgentClient,
          action,
          config.dryRun,
          actionContext,
        );

        emitter.emit("action-complete", {
          actionIndex: engineIndex + 1,
          totalActions: globalMaxConcurrency,
          repo: ctx.repoKey,
          noCommitsPushed: result.noCommitsPushed || false,
        });

        if (result.noCommitsPushed) {
          note(`✓ done — no new commits pushed to branch (Claude ran but made no changes)`, 2);
        } else {
          note(`✓ done`, 2);
        }

        if (action.type === "squash-merge") {
          const mergedIssueNumbers = new Set<number>();
          const mergedPR = snapshot.pullRequests.find((p) => p.number === action.pullRequestNumber);
          if (mergedPR) {
            const linked =
              mergedPR.closingIssueNumbers.length > 0
                ? mergedPR.closingIssueNumbers
                : mergedPR.linkedIssueNumbers;
            for (const n of linked) mergedIssueNumbers.add(n);
          }
          if (mergedIssueNumbers.size > 0) {
            broadcastLifecycleUpdate(
              snapshot,
              new Set(),
              mergedIssueNumbers,
              blockedIssueNumbers,
              config.projectMode !== undefined,
              config.focusMode,
              emitter,
              ctx.repoKey,
            );
          }
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (isClaudeUsageLimitMessage(errorMessage)) {
          cycleRateLimitedUntilMs = getClaudeQuotaBlockedUntilMs();
        }
        emitter.emit("action-error", {
          actionIndex: engineIndex + 1,
          totalActions: globalMaxConcurrency,
          repo: ctx.repoKey,
          error: errorMessage,
        });
        note(`✗ failed: ${errorMessage}`, 2);
      } finally {
        claimedActions.delete(repoActionKey(ctx.repoKey, action));
        // The project's state changed; force a fresh snapshot next plan so the
        // just-finished action is not re-proposed from a stale cache.
        ctx.snapshotCache = null;
      }
    } else {
      section(`Engine ${engineIndex + 1}: Idle`);
      bullet("nothing to do this cycle");
      emitter.emit("engine-idle", {
        engineIndex,
        reason: "nothing to do this cycle",
      });
    }

    if (isOnceMode) {
      if (shutdownSignal.requested) {
        emitter.emit("engine-shutdown", { engineIndex });
        write(`Engine ${engineIndex + 1}: shutdown — no further work will be done.`);
      }
      return;
    }

    // ── Wait phase ──────────────────────────────────────────────────────────
    const elapsed = Date.now() - cycleStart;
    const remainingMs = Math.max(0, globalCycleMinimumMs - elapsed);
    if (remainingMs > 0) {
      emitter.emit("engine-idle", {
        engineIndex,
        nextCycleAtMs: Date.now() + remainingMs,
        ...(cycleRateLimitedUntilMs !== undefined
          ? { rateLimitedUntilMs: cycleRateLimitedUntilMs }
          : {}),
      });
      blank();
      write(`Engine ${engineIndex + 1}: next cycle in ${formatDuration(remainingMs)}.`);

      const pollIntervalMs = 10000;
      const waitStart = Date.now();
      while (Date.now() - waitStart < remainingMs && !shutdownSignal.requested && !cancelSignal.requested) {
        const timeLeft = remainingMs - (Date.now() - waitStart);
        if (timeLeft <= 0) break;
        await delay(Math.min(pollIntervalMs, timeLeft));

        // Engine 0 keeps every project's feed alive between cycles.
        if (engineIndex === 0) {
          for (const ctx of contexts) {
            const now = Date.now();
            if (
              now - ctx.pollingState.lastPolledAt >= pollIntervalMs &&
              Date.now() - waitStart < remainingMs - 1000
            ) {
              ctx.pollingState.lastPolledAt = now;
              await broadcastBetweenCycleActivity(ctx, claimedActions, emitter);
            }
          }
        }
      }
    }
  } while (true);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const noBrowser = argv.includes("--no-browser");

  const envConfig = loadEnvConfig();
  const emitter = globalEventEmitter;
  const shutdownSignal = { requested: false };

  // Listen for Escape key on the console to trigger graceful shutdown
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      if (chunk[0] === 0x03) {
        process.exit(0);
      }
      if (chunk[0] === 0x1b && chunk.length === 1 && !shutdownSignal.requested) {
        shutdownSignal.requested = true;
        process.stdin.pause();
        process.stdin.setRawMode(false);
        blank();
        write("Escape key pressed. Will shutdown engines and quit after work finishes.");
        emitter.emit("shutdown-requested", {});
      }
    });
  }

  // ── Build one runtime context per configured project ──────────────────────
  const globalMaxConcurrency = envConfig.max_concurrency ?? 3;
  const globalCycleMinimumMs = Math.round((envConfig.cycle_minimum_seconds ?? 60) * 1000);
  const multiProject = envConfig.projects.length > 1;

  const contexts: ProjectContext[] = envConfig.projects.map((projectEnvConfig) => {
    const config = buildProjectConfig(projectEnvConfig, envConfig, { once, dryRun, noBrowser });
    const githubToken = resolveGitHubToken(envConfig, projectEnvConfig.github_token_name);
    const githubGateway = new GitHubApiGateway({
      token: githubToken,
      apiBaseUrl: envConfig.github_api_base_url ?? "https://api.github.com",
      apiVersion: envConfig.github_api_version ?? "2022-11-28",
      userAgent: "vibrator",
      eventEmitter: emitter,
    });
    const gitHubClient = new GitHubClient({ owner: config.owner, repo: config.repo, gateway: githubGateway });
    const claudeAgentClient = createClaudeAgentClient({
      githubGateway,
      githubToken,
      ...(config.claudeModel !== undefined ? { claudeModel: config.claudeModel } : {}),
      ...(config.claudeCommitModel !== undefined ? { claudeCommitModel: config.claudeCommitModel } : {}),
    });
    return {
      config,
      repoKey: `${config.owner}/${config.repo}`,
      githubGateway,
      githubToken,
      gitHubClient,
      sessionStore: new FileSessionStore(config.sessionStorePath),
      claudeAgentClient,
      pollingState: { lastPolledAt: 0, lastSnapshot: null, seenCommitHashes: new Set<string>() },
      cap: Math.min(config.maxConcurrency, globalMaxConcurrency),
      snapshotCache: null,
      lastMaintenanceAtMs: 0,
    } satisfies ProjectContext;
  });

  // ── Resolve the single dashboard title ────────────────────────────────────
  // Multi-project: a neutral title (each item carries its own project label).
  // Single-project: the project's name in the title, as before.
  let dashboardTitle = "Vibrator";
  const first = contexts[0]!;
  const firstProjectEnv = envConfig.projects[0]!;
  // Global `dashboard_title` wins; the per-project field is a deprecated fallback.
  const titleOverride = envConfig.dashboard_title ?? firstProjectEnv.dashboard_title;
  if (!multiProject) {
    let projectTitle: string | undefined;
    if (titleOverride === undefined && first.config.projectMode) {
      try {
        const titleClient = new GitHubClient({
          owner: first.config.owner,
          repo: first.config.repo,
          token: first.githubToken,
        });
        projectTitle = await titleClient.getProjectTitle(first.config.projectMode.projectNumber);
      } catch (error) {
        console.warn(
          `[vibrator] Could not resolve project title for dashboard header: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    dashboardTitle = resolveDashboardTitle(
      titleOverride,
      first.config.repo,
      first.config.projectMode,
      projectTitle,
    );
  } else if (titleOverride !== undefined) {
    dashboardTitle = titleOverride;
  }

  // ── Start the single dashboard server ─────────────────────────────────────
  const dashboardPort = envConfig.dashboard_port ?? firstProjectEnv.dashboard_port ?? 3000;
  const dashboard = new DashboardServer({
    port: dashboardPort,
    owner: multiProject ? "" : first.config.owner,
    repo: multiProject ? "" : first.config.repo,
    dashboardTitle,
    maxConcurrency: globalMaxConcurrency,
    multiProject,
    projects: contexts.map((c) => c.repoKey),
    eventEmitter: emitter,
  });
  let dashboardReady = false;
  try {
    await dashboard.initialize();
    await dashboard.start();
    if (!noBrowser) {
      await dashboard.openBrowser();
    }
    dashboardReady = true;
  } catch (error) {
    console.error(
      `[Dashboard] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  write(HEAVY_RULE);
  write(`vibrator starting · ${timestamp()}`);
  write(`projects (${contexts.length}): ${contexts.map((c) => `${c.repoKey} [cap ${c.cap}]`).join(", ")}`);
  if (dashboardReady) {
    write(`dashboard: ${dashboard.getUrl()}${noBrowser ? " (browser launch suppressed)" : ""}`);
    const bundlePath = path.join(process.cwd(), "dist", "dashboard", "bundle.js");
    if (!fs.existsSync(bundlePath)) {
      console.warn(
        `[Dashboard] WARNING: dist/dashboard/bundle.js not found — the dashboard UI will not load.\n` +
        `Run: npm run build:dashboard`,
      );
    }
  } else {
    write(`dashboard: failed to start (check if port ${dashboardPort} is available)`);
  }
  const modeNotes: string[] = [];
  if (once) modeNotes.push("--once");
  if (dryRun) modeNotes.push("--dry-run");
  if (noBrowser) modeNotes.push("--no-browser");
  write(
    `cycle-minimum: ${formatDuration(globalCycleMinimumMs)} · pool: ${globalMaxConcurrency} cylinder(s)` +
      (modeNotes.length > 0 ? ` · mode: ${modeNotes.join(", ")}` : ""),
  );
  write(HEAVY_RULE);

  // ── Per-project startup: ensure the "manual"/"focus" labels exist ─────────
  for (const ctx of contexts) {
    const { bullet, note, section } = createLogger(emitter, ctx.repoKey);
    section(`${ctx.repoKey}: Startup`);
    note("ensuring the \"manual\" label exists on the repository…");
    try {
      await ctx.gitHubClient.ensureLabelExists(
        "manual",
        "e0e0e0",
        "Prevents vibrator from automatically picking up this issue",
      );
      bullet("\"manual\" label is present");
    } catch (error) {
      bullet(`could not ensure "manual" label exists: ${(error as Error).message}`);
    }
    if (ctx.config.focusMode) {
      note(`ensuring the "${FOCUS_LABEL}" label exists on the repository…`);
      try {
        await ctx.gitHubClient.ensureLabelExists(
          FOCUS_LABEL,
          "0075ca",
          "Vibrator will only work on issues with this label in focus mode",
        );
        bullet(`"${FOCUS_LABEL}" label is present`);
      } catch (error) {
        bullet(`could not ensure "${FOCUS_LABEL}" label exists: ${(error as Error).message}`);
      }
    }
  }

  // ── Launch the shared engine pool ─────────────────────────────────────────
  const planningMutex = new PlanningMutex();
  const claimedActions = new Set<string>();
  const cancelSignals = Array.from({ length: globalMaxConcurrency }, () => ({ requested: false }));

  emitter.subscribe((event) => {
    if (event.type === "cylinder-cancel") {
      const engineIndex = event.data.engineIndex as number;
      if (typeof engineIndex === "number" && engineIndex >= 0 && engineIndex < cancelSignals.length) {
        const signal = cancelSignals[engineIndex];
        if (signal) signal.requested = true;
      }
    }
  });

  const engines = Array.from({ length: globalMaxConcurrency }, (_, i) =>
    runEngine(
      i,
      contexts,
      globalMaxConcurrency,
      globalCycleMinimumMs,
      planningMutex,
      claimedActions,
      shutdownSignal,
      cancelSignals[i]!,
      emitter,
    ),
  );

  await Promise.all(engines);

  blank();
  if (shutdownSignal.requested) {
    write("All engines shut down. Exiting.");
    emitter.emit("app-shutdown", {});
    await delay(500);
  } else {
    write(`Done (--once mode). Exiting.`);
    if (process.stdin.isTTY) {
      process.stdin.pause();
      process.stdin.setRawMode(false);
    }
  }
  if (dashboardReady) {
    dashboard.close();
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`[${timestamp()}] Fatal error:`, error);
  process.exit(1);
});
