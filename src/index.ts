import { setTimeout as delay } from "node:timers/promises";

import "dotenv/config";

import { executeAction, type ExecuteActionResult } from "./actions.js";
import { createClaudeAgentClient } from "./claude-agent.js";
import {
  buildDefaultSessionStorePath,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { buildPlan } from "./orchestrator.js";
import { reconcileSessions } from "./reconcile.js";
import { FileSessionStore } from "./session-store.js";
import { DashboardServer } from "./dashboard-server.js";
import { globalEventEmitter } from "./event-emitter.js";
import {
  broadcastRepositorySnapshot,
  broadcastPullRequestUpdate,
  broadcastCIStatus,
  broadcastIssueUpdate,
  broadcastCommit,
  emitLogMessage,
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

async function broadcastBetweenCycleActivity(
  config: Config,
  lastSnapshot: RepositorySnapshot | null,
): Promise<RepositorySnapshot> {
  try {
    const gitHubClient = new GitHubClient({
      owner: config.owner,
      repo: config.repo,
      token: config.token,
    });
    const sessionStore = new FileSessionStore(config.sessionStorePath);

    const snapshot = await loadSnapshot(gitHubClient, sessionStore);

    // Broadcast current repository state
    broadcastRepositorySnapshot(snapshot, config.owner, config.repo);

    // Broadcast any open PRs
    for (const pr of snapshot.pullRequests.filter((p) => p.state === "open")) {
      broadcastPullRequestUpdate(pr, "monitoring");
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

    // Broadcast recent commits
    try {
      const recentCommits = await gitHubClient.listRecentCommits(5);
      for (const commit of recentCommits) {
        broadcastCommit(commit);
      }
    } catch (error) {
      // Silently skip commit broadcasting if it fails
    }

    return snapshot;
  } catch (error) {
    // Silently fail on between-cycle polling errors
    return lastSnapshot || ({ pullRequests: [], issues: [], agentSessions: [] } as RepositorySnapshot);
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
  token: string;
  anthropicApiKey: string;
  claudeModel: string | undefined;
  maxConcurrency: number;
  intervalMs: number;
  once: boolean;
  dryRun: boolean;
  sessionStorePath: string;
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
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Set GITHUB_TOKEN before running vibrator.");
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("Set ANTHROPIC_API_KEY before running vibrator.");
  }

  const maxConcurrency = Number.parseInt(process.env.MAX_CONCURRENCY ?? "3", 10);
  const intervalMs = Number.parseInt(process.env.LOOP_INTERVAL_MS ?? "60000", 10);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const sessionStorePath =
    process.env.VIBRATOR_SESSION_STORE_PATH ?? buildDefaultSessionStorePath(owner, repo);
  const claudeModel = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

  return {
    owner,
    repo,
    token,
    anthropicApiKey,
    claudeModel,
    maxConcurrency: Number.isNaN(maxConcurrency) ? 3 : maxConcurrency,
    intervalMs: Number.isNaN(intervalMs) ? 60000 : intervalMs,
    once,
    dryRun,
    sessionStorePath,
  };
}

async function runIteration(config: Config, iterationNumber: number): Promise<void> {
  const repo = `${config.owner}/${config.repo}`;
  const gitHubClient = new GitHubClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
  });
  const sessionStore = new FileSessionStore(config.sessionStorePath);
  const claudeAgentClient = createClaudeAgentClient({
    anthropicApiKey: config.anthropicApiKey,
    ...(config.claudeModel !== undefined && { claudeModel: config.claudeModel }),
  });

  globalEventEmitter.emit("iteration-start", {
    iterationNumber,
    repo,
    timestamp,
  });

  write(HEAVY_RULE);
  write(`vibrator status update · ${timestamp()} · iteration ${iterationNumber}`);
  write(`repo: ${repo} (${gitHubClient.repositoryUrl()})`);
  const modeNotes: string[] = [];
  if (config.dryRun) modeNotes.push("DRY RUN");
  if (config.once) modeNotes.push("--once");
  write(
    `concurrency: ${config.maxConcurrency} · interval: ${formatDuration(config.intervalMs)}` +
      (modeNotes.length > 0 ? ` · mode: ${modeNotes.join(", ")}` : ""),
  );
  write(HEAVY_RULE);

  // --- Workflow approvals ------------------------------------------------
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

  // --- Repository snapshot ----------------------------------------------
  const snapshot = await loadSnapshot(gitHubClient, sessionStore);
  const draftPullRequestCount = snapshot.pullRequests.filter((pr) => pr.draft).length;
  const readyPullRequestCount = snapshot.pullRequests.length - draftPullRequestCount;
  const preReconcileActiveSessions = snapshot.agentSessions.filter(
    (s) => s.status === "in_progress",
  );

  globalEventEmitter.emit("snapshot-update", {
    issueCount: snapshot.issues.length,
    prCount: snapshot.pullRequests.length,
    draftPrCount: draftPullRequestCount,
    readyPrCount: readyPullRequestCount,
    sessionCount: preReconcileActiveSessions.length,
  });

  // Broadcast repository snapshot and PR updates to dashboard
  broadcastRepositorySnapshot(snapshot, config.owner, config.repo);
  for (const pr of snapshot.pullRequests.filter((p) => p.state === "open")) {
    const draftLabel = pr.draft ? "[DRAFT]" : "";
    const checksLabel = pr.checksStatus === "success" ? "[CHECKS OK]" : "[CHECKS " + pr.checksStatus.toUpperCase() + "]";
    broadcastPullRequestUpdate(pr, `tracking ${draftLabel} ${checksLabel}`);
  }

  globalEventEmitter.emit("phase-update", { phase: "implementation" });

  section("Repository snapshot");
  bullet(`${snapshot.issues.length} open issue(s)`);
  bullet(
    `${snapshot.pullRequests.length} open pull request(s)` +
      (snapshot.pullRequests.length > 0
        ? ` (${draftPullRequestCount} draft, ${readyPullRequestCount} ready)`
        : ""),
  );
  bullet(`${preReconcileActiveSessions.length} active agent session(s)`);
  for (const session of preReconcileActiveSessions) {
    note(`◦ ${describeSession(session, gitHubClient)}`, 2);
  }

  // --- Reconciliation ---------------------------------------------------
  // Every Claude action runs synchronously, so any `in_progress` session
  // observed here can only be the carcass of a previous vibrator process
  // that crashed mid-action. Fail those so the planner can re-plan.
  section("Reconciliation");
  const reconcileEvents = await reconcileSessions(sessionStore, snapshot.agentSessions);
  bullet(`${reconcileEvents.length} stale session(s) failed`);
  for (const event of reconcileEvents) {
    note(`◦ ${describeSession(event.session, gitHubClient)}`, 2);
  }

  snapshot.agentSessions = await sessionStore.load();

  // --- Plan -------------------------------------------------------------
  globalEventEmitter.emit("phase-update", { phase: "review" });

  const plan = buildPlan(snapshot, config.maxConcurrency);
  const blockedEntries = Object.entries(plan.blockedIssueNumbers);

  section("Blocked issues");
  if (blockedEntries.length === 0) {
    note("(none)");
  } else {
    for (const [blocked, blockers] of blockedEntries) {
      const blockedNumber = Number.parseInt(blocked, 10);
      const blockerSummary = blockers
        .map((n) => `#${n} (${gitHubClient.issueUrl(n)})`)
        .join(", ");
      bullet(`#${blockedNumber} (${gitHubClient.issueUrl(blockedNumber)}) blocked by ${blockerSummary}`);
    }
  }

  section("Plan");
  if (plan.actions.length === 0) {
    bullet("0 actions to execute");
  } else {
    bullet(
      `${plan.actions.length} action(s) to execute` +
        (plan.actions.length > 1 ? ` — running concurrently` : ""),
    );
    for (let i = 0; i < plan.actions.length; i++) {
      note(
        `[${i + 1}/${plan.actions.length}] → ${describeAction(plan.actions[i]!, snapshot, gitHubClient)}`,
        2,
      );
    }

    if (!config.dryRun) {
      globalEventEmitter.emit("phase-update", { phase: "implementation" });

      const actionContext = {
        owner: config.owner,
        repo: config.repo,
        issues: snapshot.issues,
        pullRequests: snapshot.pullRequests,
      };

      const results = await Promise.allSettled(
        plan.actions.map((action, index) => {
          globalEventEmitter.emit("action-start", {
            actionIndex: index + 1,
            totalActions: plan.actions.length,
            description: describeAction(action, snapshot, gitHubClient),
            type: action.type,
          });
          return executeAction(
            gitHubClient,
            sessionStore,
            claudeAgentClient,
            action,
            false,
            actionContext,
          );
        }),
      );

      blank();
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const prefix = `[${i + 1}/${plan.actions.length}]`;
        if (result.status === "fulfilled") {
          const actionResult: ExecuteActionResult = result.value;
          globalEventEmitter.emit("action-complete", {
            actionIndex: i + 1,
            totalActions: plan.actions.length,
            noCommitsPushed: actionResult.noCommitsPushed || false,
          });
          if (actionResult.noCommitsPushed) {
            note(`${prefix} ⚠ done — no new commits pushed to branch (Claude ran but made no changes)`, 2);
          } else {
            note(`${prefix} ✓ done`, 2);
          }
        } else {
          globalEventEmitter.emit("action-error", {
            actionIndex: i + 1,
            totalActions: plan.actions.length,
            error: (result.reason as Error).message,
          });
          note(
            `${prefix} ✗ failed: ${(result.reason as Error).message}`,
            2,
          );
        }
      }
    } else {
      blank();
      for (let i = 0; i < plan.actions.length; i++) {
        globalEventEmitter.emit("action-complete", {
          actionIndex: i + 1,
          totalActions: plan.actions.length,
          dryRun: true,
        });
        note(`[${i + 1}/${plan.actions.length}] ✓ done (dry-run)`, 2);
      }
    }
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const repositoryUrl = `https://github.com/${config.owner}/${config.repo}`;

  // Start dashboard server
  const dashboard = new DashboardServer({ port: 3000 });
  await dashboard.initialize();
  await dashboard.start();
  await dashboard.openBrowser();

  write(HEAVY_RULE);
  write(`vibrator starting · ${timestamp()}`);
  write(`repo: ${config.owner}/${config.repo} (${repositoryUrl})`);
  write(`dashboard: ${dashboard.getUrl()}`);
  const modeNotes: string[] = [];
  if (config.once) modeNotes.push("--once");
  if (config.dryRun) modeNotes.push("--dry-run");
  write(
    `interval: ${formatDuration(config.intervalMs)} · concurrency: ${config.maxConcurrency}` +
      (modeNotes.length > 0 ? ` · mode: ${modeNotes.join(", ")}` : ""),
  );
  write(HEAVY_RULE);

  let iterationNumber = 0;
  let lastSnapshot: RepositorySnapshot | null = null;

  do {
    iterationNumber++;

    const iterationStartTime = Date.now();
    await runIteration(config, iterationNumber);

    if (config.once) {
      blank();
      write(`Done (--once mode). Exiting.`);
      dashboard.close();
      return;
    }

    // Calculate time until next cycle, accounting for iteration duration
    const elapsedMs = Date.now() - iterationStartTime;
    const remainingMs = Math.max(0, config.intervalMs - elapsedMs);

    blank();
    write(`Next iteration in ${formatDuration(remainingMs)}.`);

    // Emit countdown with remaining time
    globalEventEmitter.emit("cycle-countdown", {
      msUntilCycle: remainingMs,
      nextCycleTime: new Date(Date.now() + remainingMs).toISOString(),
    });

    // Broadcast GitHub activity during idle period to keep dashboard vibrant
    const pollIntervalMs = 10000; // Poll every 10 seconds
    const startWaitTime = Date.now();
    while (Date.now() - startWaitTime < remainingMs) {
      const timeLeftMs = remainingMs - (Date.now() - startWaitTime);
      if (timeLeftMs <= 0) break;

      const waitMs = Math.min(pollIntervalMs, timeLeftMs);
      await delay(waitMs);

      // Broadcast activity if time permits
      if (Date.now() - startWaitTime < remainingMs - 1000) {
        lastSnapshot = await broadcastBetweenCycleActivity(config, lastSnapshot);
      }
    }
  } while (true);
}

main().catch((error: unknown) => {
  console.error(`[${timestamp()}] Fatal error:`, error);
  process.exitCode = 1;
});
