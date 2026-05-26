import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import "dotenv/config";

import { executeAction, type ExecuteActionResult } from "./actions.js";
import {
  createClaudeAgentClient,
  DEFAULT_COMMIT_MODEL,
  isClaudeUsageLimitMessage,
  getClaudeQuotaBlockedUntilMs,
} from "./claude-agent.js";
import {
  buildDefaultSessionStorePath,
  getGitHubTokenFromEnv,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { GitHubApiGateway } from "./github-gateway.js";
import { buildPlan, type ProjectModeConfig } from "./orchestrator.js";
import { reconcileSessions } from "./reconcile.js";
import { FileSessionStore } from "./session-store.js";
import { DashboardServer } from "./dashboard-server.js";
import { resolveDashboardTitle } from "./dashboard-title.js";
import { globalEventEmitter } from "./event-emitter.js";
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

function section(title: string): void {
  blank();
  write(title);
  write(RULE);
}

function bullet(text: string, indent = 1): void {
  const pad = "  ".repeat(indent);
  write(`${pad}• ${text}`);
}

function note(text: string, indent = 1): void {
  const pad = "  ".repeat(indent);
  write(`${pad}${text}`);
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

/** Serialises planning across N concurrent engines to prevent double-booking. */
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

/**
 * Stable claim key identifying the *resource* an action operates on — an
 * issue or a pull request — deliberately NOT the action type.
 *
 * Claims are keyed by resource so two engines can never run different actions
 * against the same PR concurrently. The `in_progress` session that normally
 * blocks re-planning is created inside `executeAction`, *after* the planning
 * mutex is released. If claims were keyed by `type:number`, a second engine
 * planning in that window could pick a different-typed action for the same PR
 * (e.g. `address-failing-checks` while the first engine runs `self-review`),
 * find that distinct key unclaimed, and double-book the PR onto two engines.
 */
function actionKey(action: OrchestratorAction): string {
  if (action.type === "start-implementation") {
    return `issue:${action.issueNumber}`;
  }
  return `pr:${action.pullRequestNumber}`;
}

/**
 * Extract the set of issue numbers that have a currently-claimed
 * `start-implementation` action (key form `issue:NUM`). Used to ensure
 * in-flight implementations always render as "planning" in the lifecycle
 * pane, even when the planner has dropped the issue from `plan.actions`
 * (e.g. in project mode after `moveIssueToProjectStatus(..., "In Progress")`
 * runs, the next planner sees status≠Ready and excludes the issue).
 */
function claimedImplementationIssueNumbers(claimedActions: ReadonlySet<string>): Set<number> {
  const issueNumbers = new Set<number>();
  for (const key of claimedActions) {
    if (key.startsWith("issue:")) {
      const n = Number.parseInt(key.slice(6), 10);
      if (!Number.isNaN(n)) issueNumbers.add(n);
    }
  }
  return issueNumbers;
}

interface PollingState {
  lastPolledAt: number;
  lastSnapshot: RepositorySnapshot | null;
  seenCommitHashes: Set<string>;
}

async function broadcastBetweenCycleActivity(
  config: Config,
  githubGateway: GitHubApiGateway,
  lastSnapshot: RepositorySnapshot | null,
  seenCommitHashes: Set<string>,
  claimedActions: ReadonlySet<string>,
): Promise<{ snapshot: RepositorySnapshot; seenCommitHashes: Set<string> }> {
  try {
    const gitHubClient = new GitHubClient({
      owner: config.owner,
      repo: config.repo,
      gateway: githubGateway,
    });
    const sessionStore = new FileSessionStore(config.sessionStorePath);

    const snapshot = await loadSnapshot(
      gitHubClient,
      sessionStore,
      config.projectMode ? { projectNumber: config.projectMode.projectNumber } : undefined,
    );

    // Broadcast current repository state only when something changed
    const lastPrMap = lastSnapshot
      ? new Map(lastSnapshot.pullRequests.map((p) => [p.number, p]))
      : null;
    const snapshotChanged = !lastSnapshot ||
      lastSnapshot.issues.length !== snapshot.issues.length ||
      lastSnapshot.pullRequests.length !== snapshot.pullRequests.length ||
      lastSnapshot.agentSessions.filter((s) => s.status === "in_progress").length !==
        snapshot.agentSessions.filter((s) => s.status === "in_progress").length;
    if (snapshotChanged) {
      broadcastRepositorySnapshot(snapshot, config.owner, config.repo);
    }
    const { blockedIssueNumbers } = buildPlan(snapshot, config.maxConcurrency, config.projectMode);
    // Include in-flight implementations (claimed but not yet completed) so
    // their pills keep pulsing "implementing…" between cycles instead of
    // dropping back to absent. See `claimedImplementationIssueNumbers` for
    // why the planner's own output is not enough on its own.
    broadcastLifecycleUpdate(
      snapshot,
      claimedImplementationIssueNumbers(claimedActions),
      new Set(),
      blockedIssueNumbers,
      config.projectMode !== undefined,
    );

    // Broadcast open PRs only when their state has changed since the last poll
    for (const pr of snapshot.pullRequests.filter((p) => p.state === "open")) {
      const lastPr = lastPrMap?.get(pr.number);
      const prChanged = !lastPr || hasPrStateChanged(pr, lastPr);

      if (prChanged) {
        broadcastPullRequestUpdate(pr, "monitoring");
      }

      // Broadcast review comments only when the unresolved count changed
      const reviewCountChanged = !lastPr ||
        lastPr.unresolvedReviewCommentCount !== pr.unresolvedReviewCommentCount;
      if (reviewCountChanged) {
        try {
          const reviewComments = await gitHubClient.listUnresolvedReviewComments(pr.number);
          if (reviewComments.length > 0) {
            broadcastReviewComment(pr.number, "Review", reviewComments.length);
          }
        } catch (error) {
          // Silently skip review comment broadcasting if it fails
        }
      }
    }

    // Broadcast issue activity: new or recently updated issues
    if (lastSnapshot) {
      const lastIssueMap = new Map(lastSnapshot.issues.map((i) => [i.number, i]));
      for (const issue of snapshot.issues) {
        const lastIssue = lastIssueMap.get(issue.number);
        // Broadcast if this is a new issue or recently updated
        if (!lastIssue || new Date(issue.updatedAt) > new Date(lastIssue.updatedAt)) {
          broadcastIssueUpdate(issue, lastIssue ? "updated" : "opened");
        }
      }
    }

    // Broadcast only commits not yet seen in the feed
    const newSeenHashes = new Set(seenCommitHashes);
    try {
      const recentCommits = await gitHubClient.listRecentCommits(5);
      for (const commit of filterNewCommits(recentCommits, seenCommitHashes)) {
        broadcastCommit(commit);
        newSeenHashes.add(commit.hash);
      }
    } catch (error) {
      // Silently skip commit broadcasting if it fails
    }

    return { snapshot, seenCommitHashes: newSeenHashes };
  } catch (error) {
    // Silently fail on between-cycle polling errors
    return {
      snapshot: lastSnapshot || ({ pullRequests: [], issues: [], agentSessions: [] } as RepositorySnapshot),
      seenCommitHashes,
    };
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
  maxConcurrency: number;
  cycleMinimumMs: number;
  dashboardPort: number;
  dashboardTitle: string | undefined;
  once: boolean;
  dryRun: boolean;
  noBrowser: boolean;
  sessionStorePath: string;
  /** Human-in-the-Loop project mode config. Undefined = standard auto-merge mode. */
  projectMode: ProjectModeConfig | undefined;
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

function parseArgs(argv: string[]): Config {
  const repositoryArgument = argv.find((argument) => !argument.startsWith("--"));
  const repository = repositoryArgument ?? process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("Provide a repository slug such as owner/repo.");
  }

  const { owner, repo } = parseRepositorySlug(repository);
  const maxConcurrency = Number.parseInt(process.env.MAX_CONCURRENCY ?? "3", 10);
  const cycleMinimumSeconds = Number.parseFloat(process.env.CYCLE_MINIMUM_SECONDS ?? "60");
  const dashboardPort = Number.parseInt(process.env.DASHBOARD_PORT ?? "3000", 10);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const noBrowser = argv.includes("--no-browser");
  const sessionStorePath =
    process.env.VIBRATOR_SESSION_STORE_PATH ?? buildDefaultSessionStorePath(owner, repo);
  const dashboardTitle = process.env.DASHBOARD_TITLE;
  const claudeModel = process.env.CLAUDE_MODEL;
  const claudeCommitModel = process.env.CLAUDE_COMMIT_MODEL;

  const projectNumberRaw = process.env.GITHUB_PROJECT_NUMBER;
  const projectNumber = projectNumberRaw
    ? Number.parseInt(projectNumberRaw, 10)
    : undefined;
  const reviewersRaw = process.env.VIBRATOR_REVIEWERS;
  const reviewers = reviewersRaw
    ? reviewersRaw.split(",").map((r) => r.trim()).filter(Boolean)
    : [];
  const projectMode: ProjectModeConfig | undefined =
    projectNumber !== undefined && !Number.isNaN(projectNumber)
      ? { projectNumber, reviewers }
      : undefined;

  return {
    owner,
    repo,
    claudeModel,
    claudeCommitModel,
    maxConcurrency: Number.isNaN(maxConcurrency) ? 3 : maxConcurrency,
    cycleMinimumMs: Number.isNaN(cycleMinimumSeconds) ? 60000 : Math.round(cycleMinimumSeconds * 1000),
    dashboardPort: Number.isNaN(dashboardPort) ? 3000 : dashboardPort,
    dashboardTitle,
    once,
    dryRun,
    noBrowser,
    sessionStorePath,
    projectMode,
  };
}

async function runEngineLoop(
  config: Config,
  githubGateway: GitHubApiGateway,
  githubToken: string,
  engineIndex: number,
  planningMutex: PlanningMutex,
  claimedActions: Set<string>,
  pollingState: PollingState,
  shutdownSignal: { requested: boolean },
): Promise<void> {
  const repo = `${config.owner}/${config.repo}`;
  const gitHubClient = new GitHubClient({
    owner: config.owner,
    repo: config.repo,
    gateway: githubGateway,
  });
  const sessionStore = new FileSessionStore(config.sessionStorePath);

  const claudeAgentClient = createClaudeAgentClient({
    githubGateway,
    githubToken,
    ...(config.claudeModel !== undefined ? { claudeModel: config.claudeModel } : {}),
    ...(config.claudeCommitModel !== undefined ? { claudeCommitModel: config.claudeCommitModel } : {}),
    engineIndex,
  });

  let iterationNumber = 0;

  do {
    if (shutdownSignal.requested) {
      globalEventEmitter.emit("engine-shutdown", { engineIndex });
      write(`Engine ${engineIndex + 1}: shutdown — no further work will be done.`);
      return;
    }

    const cycleStart = Date.now();
    iterationNumber++;

    const githubHold = githubGateway.currentRateLimitHold();
    if (githubHold && Date.now() < githubHold.blockedUntilMs) {
      globalEventEmitter.emit("engine-idle", {
        engineIndex,
        reason: "github-rate-limit",
        rateLimitedUntilMs: githubHold.blockedUntilMs,
        nextCycleAtMs: githubHold.blockedUntilMs,
      });
      await githubGateway.waitUntilReady();
      continue;
    }

    globalEventEmitter.emit("iteration-start", {
      iterationNumber,
      engineIndex,
      maxConcurrency: config.maxConcurrency,
    });

    // ── Planning phase (serialised via mutex to prevent double-booking) ────
    const planned = await planningMutex.withLock(async () => {
      // Engine 0 only: global tasks that must run exactly once per cycle
      if (engineIndex === 0) {
        section("Workflow approvals");
        try {
          const pendingRuns = await gitHubClient.listWorkflowRunsAwaitingApproval();
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
                const result = await gitHubClient.approveWorkflowRun(run.id);
                note(result.approved ? `✓ approved ${label}` : `skipped ${label}: ${result.reason}`, 2);
                globalEventEmitter.emit("workflow-approval", {
                  runId: run.id,
                  runName: run.name,
                  approved: result.approved,
                });
              } catch (error) {
                note(`✗ failed to approve ${label}: ${(error as Error).message}`, 2);
              }
            }
          }
        } catch (error) {
          bullet(`failed to list workflow runs awaiting approval: ${(error as Error).message}`);
        }
      }

      const snapshot = await loadSnapshot(
        gitHubClient,
        sessionStore,
        config.projectMode ? { projectNumber: config.projectMode.projectNumber } : undefined,
      );
      const openPullRequests = snapshot.pullRequests.filter((p) => p.state === "open");

      if (engineIndex === 0) {
        // Reconcile stale sessions before planning so the planner sees clean state
        section("Reconciliation");
        const reconcileEvents = await reconcileSessions(sessionStore, snapshot.agentSessions);
        bullet(`${reconcileEvents.length} stale session(s) failed`);
        for (const event of reconcileEvents) {
          note(`◦ ${describeSession(event.session, gitHubClient)}`, 2);
        }
        snapshot.agentSessions = await sessionStore.load();

        const activeSessions = snapshot.agentSessions.filter((s) => s.status === "in_progress");

        globalEventEmitter.emit("snapshot-update", {
          issueCount: snapshot.issues.length,
          prCount: openPullRequests.length,
          draftPrCount: openPullRequests.filter((pr) => pr.draft).length,
          readyPrCount: openPullRequests.filter((pr) => !pr.draft).length,
          sessionCount: activeSessions.length,
          issues: snapshot.issues.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
          })),
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

        broadcastRepositorySnapshot(snapshot, config.owner, config.repo, activeSessions.length);
        for (const pr of openPullRequests) {
          const draftLabel = pr.draft ? "[DRAFT]" : "";
          const checksLabel = pr.checksStatus === "success" ? "[CHECKS OK]" : "[CHECKS " + pr.checksStatus.toUpperCase() + "]";
          broadcastPullRequestUpdate(pr, `tracking ${draftLabel} ${checksLabel}`);
        }
      }

      const plan = buildPlan(snapshot, config.maxConcurrency, config.projectMode);

      // Refresh the lifecycle pane on every engine's planning pass, not just
      // engine 0's. Gating it to engine 0 froze the pane while engine 0 was
      // busy executing a long action — leaving pills stale, e.g. stuck on
      // "implementing…" after the PR already existed and another cylinder had
      // moved on to reviewing it. Any engine planning under the mutex sees a
      // fresh snapshot, so the freshest planner's view always wins.
      //
      // Find the first unclaimed action and claim it BEFORE broadcasting, so
      // the new claim is reflected in `claimedImplementationIssueNumbers`.
      //
      // The lifecycle "planning" state (the pulsing dashed right half) must
      // coincide 1:1 with a cylinder actively working on the issue. We derive
      // it exclusively from `claimedActions` — every claimed start-impl is
      // about to fire (or has already fired) an `action-start` that maps the
      // issue to a cylinder on the client. Future-plan entries (the planner's
      // next-up start-impl targets, not yet picked by any engine) deliberately
      // do NOT pulse: they have no cylinder mapping, so showing them as
      // "implementing…" would render a pulsing row over a subdued/inactive
      // pill — the bug this guards against.
      for (const a of plan.actions) {
        const key = actionKey(a);
        if (!claimedActions.has(key)) {
          claimedActions.add(key);
          broadcastLifecycleUpdate(
            snapshot,
            claimedImplementationIssueNumbers(claimedActions),
            new Set(),
            plan.blockedIssueNumbers,
            config.projectMode !== undefined,
          );
          return { action: a, snapshot, blockedIssueNumbers: plan.blockedIssueNumbers };
        }
      }
      broadcastLifecycleUpdate(
        snapshot,
        claimedImplementationIssueNumbers(claimedActions),
        new Set(),
        plan.blockedIssueNumbers,
        config.projectMode !== undefined,
      );
      return { action: null, snapshot, blockedIssueNumbers: plan.blockedIssueNumbers };
    });

    // ── Execution phase ───────────────────────────────────────────────────
    let cycleRateLimitedUntilMs: number | undefined;
    const hasAction = planned.action !== null;
    if (hasAction) {
      const action = planned.action;
      const snapshot = planned.snapshot;

      section(`Engine ${engineIndex + 1}: Action`);
      bullet(describeAction(action, snapshot, gitHubClient));

      globalEventEmitter.emit("phase-update", { phase: "implementation" });
      globalEventEmitter.emit("action-start", {
        actionIndex: engineIndex + 1,
        totalActions: config.maxConcurrency,
        description: describeAction(action, snapshot, gitHubClient),
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
          gitHubClient,
          sessionStore,
          claudeAgentClient,
          action,
          config.dryRun,
          actionContext,
        );

        globalEventEmitter.emit("action-complete", {
          actionIndex: engineIndex + 1,
          totalActions: config.maxConcurrency,
          noCommitsPushed: result.noCommitsPushed || false,
        });

        if (result.noCommitsPushed) {
          note(`✓ done — no new commits pushed to branch (Claude ran but made no changes)`, 2);
        } else {
          note(`✓ done`, 2);
        }

        // Emit "completed" lifecycle state for squash-merged issues
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
              planned.blockedIssueNumbers,
              config.projectMode !== undefined,
            );
          }
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (isClaudeUsageLimitMessage(errorMessage)) {
          cycleRateLimitedUntilMs = getClaudeQuotaBlockedUntilMs();
        }
        globalEventEmitter.emit("action-error", {
          actionIndex: engineIndex + 1,
          totalActions: config.maxConcurrency,
          error: errorMessage,
        });
        note(`✗ failed: ${errorMessage}`, 2);
      } finally {
        claimedActions.delete(actionKey(action));
      }
    } else {
      section(`Engine ${engineIndex + 1}: Idle`);
      bullet("nothing to do this cycle");
      globalEventEmitter.emit("engine-idle", {
        engineIndex,
        reason: "nothing to do this cycle",
      });
    }

    if (config.once) {
      if (shutdownSignal.requested) {
        globalEventEmitter.emit("engine-shutdown", { engineIndex });
        write(`Engine ${engineIndex + 1}: shutdown — no further work will be done.`);
      }
      return;
    }

    // ── Wait phase: pause only if cycle time has not yet elapsed ──────────
    const elapsed = Date.now() - cycleStart;
    const remainingMs = Math.max(0, config.cycleMinimumMs - elapsed);

    if (remainingMs > 0) {
      globalEventEmitter.emit("engine-idle", {
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
      while (Date.now() - waitStart < remainingMs && !shutdownSignal.requested) {
        const timeLeft = remainingMs - (Date.now() - waitStart);
        if (timeLeft <= 0) break;

        await delay(Math.min(pollIntervalMs, timeLeft));

        // Only poll if enough time has passed globally (shared across all engines)
        const now = Date.now();
        if (
          now - pollingState.lastPolledAt >= pollIntervalMs &&
          Date.now() - waitStart < remainingMs - 1000
        ) {
          pollingState.lastPolledAt = now;
          ({ snapshot: pollingState.lastSnapshot, seenCommitHashes: pollingState.seenCommitHashes } =
            await broadcastBetweenCycleActivity(
              config,
              githubGateway,
              pollingState.lastSnapshot,
              pollingState.seenCommitHashes,
              claimedActions,
            ));
        }
      }
    }
  } while (true);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const githubToken = getGitHubTokenFromEnv();
  const githubGateway = new GitHubApiGateway({
    token: githubToken,
    apiBaseUrl: process.env.GITHUB_API_BASE_URL ?? "https://api.github.com",
    apiVersion: process.env.GITHUB_API_VERSION ?? "2022-11-28",
    userAgent: "vibrator",
  });
  const repositoryUrl = `https://github.com/${config.owner}/${config.repo}`;
  let projectTitle: string | undefined;
  if (config.dashboardTitle === undefined && config.projectMode) {
    try {
      const gitHubClient = new GitHubClient({
        owner: config.owner,
        repo: config.repo,
        token: githubToken,
      });
      projectTitle = await gitHubClient.getProjectTitle(config.projectMode.projectNumber);
    } catch (error) {
      console.warn(
        `[vibrator] Could not resolve project title for dashboard header: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const dashboardTitle = resolveDashboardTitle(
    config.dashboardTitle,
    config.repo,
    config.projectMode,
    projectTitle,
  );

  // Start the Dashboard server
  const dashboard = new DashboardServer({
    port: config.dashboardPort,
    owner: config.owner,
    repo: config.repo,
    dashboardTitle,
  });
  let dashboardReady = false;
  try {
    await dashboard.initialize();
    await dashboard.start();
    if (!config.noBrowser) {
      await dashboard.openBrowser();
    }
    dashboardReady = true;
  } catch (error) {
    console.error(
      `[Dashboard] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  write(HEAVY_RULE);
  write(`vibrator starting · ${timestamp()}`);
  write(`repo: ${config.owner}/${config.repo} (${repositoryUrl})`);
  if (dashboardReady) {
    write(`dashboard: ${dashboard.getUrl()}${config.noBrowser ? " (browser launch suppressed)" : ""}`);
    const bundlePath = path.join(process.cwd(), "dist", "dashboard", "bundle.js");
    if (!fs.existsSync(bundlePath)) {
      console.warn(
        `[Dashboard] WARNING: dist/dashboard/bundle.js not found — the dashboard UI will not load.\n` +
        `Run: npm run build:dashboard`,
      );
    }
  } else {
    write(`dashboard: failed to start (check if port ${config.dashboardPort} is available)`);
  }
  const modeNotes: string[] = [];
  if (config.once) modeNotes.push("--once");
  if (config.dryRun) modeNotes.push("--dry-run");
  if (config.noBrowser) modeNotes.push("--no-browser");
  write(
    `cycle-minimum: ${formatDuration(config.cycleMinimumMs)} · concurrency: ${config.maxConcurrency}` +
      (modeNotes.length > 0 ? ` · mode: ${modeNotes.join(", ")}` : ""),
  );
  if (config.projectMode) {
    write(
      `project mode: project #${config.projectMode.projectNumber} · no auto-merge · reviewers: ${
        config.projectMode.reviewers.length > 0
          ? config.projectMode.reviewers.join(", ")
          : "(none configured)"
      }`,
    );
  }
  write(HEAVY_RULE);

  // Ensure the "manual" label exists in the repository so users can apply it
  // to issues they want vibrator to skip.
  try {
    const startupGitHubClient = new GitHubClient({
      owner: config.owner,
      repo: config.repo,
      gateway: githubGateway,
    });
    await startupGitHubClient.ensureLabelExists(
      "manual",
      "e0e0e0",
      "Prevents vibrator from automatically picking up this issue",
    );
  } catch (error) {
    console.warn(
      `[vibrator] Could not ensure "manual" label exists: ${(error as Error).message}`,
    );
  }

  // ── Launch N independent engine loops ─────────────────────────────────────
  const planningMutex = new PlanningMutex();
  const claimedActions = new Set<string>();
  const pollingState: PollingState = {
    lastPolledAt: 0,
    lastSnapshot: null,
    seenCommitHashes: new Set<string>(),
  };
  const shutdownSignal = { requested: false };

  // Listen for Escape key on the console to trigger graceful shutdown
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      if (chunk[0] === 0x03) {
        // Ctrl+C — exit immediately (raw mode swallows SIGINT)
        process.exit(0);
      }
      if (chunk[0] === 0x1b && chunk.length === 1 && !shutdownSignal.requested) {
        shutdownSignal.requested = true;
        process.stdin.pause();
        process.stdin.setRawMode(false);
        blank();
        write("Escape key pressed. Will shutdown engines and quit after work finishes.");
        globalEventEmitter.emit("shutdown-requested", {});
      }
    });
  }

  const engines = Array.from({ length: config.maxConcurrency }, (_, i) =>
    runEngineLoop(
      config,
      githubGateway,
      githubToken,
      i,
      planningMutex,
      claimedActions,
      pollingState,
      shutdownSignal,
    ),
  );

  await Promise.all(engines);

  blank();
  if (shutdownSignal.requested) {
    write("All engines shut down. Exiting.");
    globalEventEmitter.emit("app-shutdown", {});
    // Give the dashboard a moment to deliver the event to connected browsers
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
