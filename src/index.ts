import { setTimeout as delay } from "node:timers/promises";

import "dotenv/config";

import { executeAction } from "./actions.js";
import {
  buildDefaultSessionStorePath,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { buildPlan } from "./orchestrator.js";
import { reconcileSessions } from "./reconcile.js";
import { FileSessionStore } from "./session-store.js";
import type {
  AgentSession,
  OrchestratorAction,
  RepositorySnapshot,
} from "./types.js";

const DEFAULT_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RULE = "─".repeat(80);
const HEAVY_RULE = "═".repeat(80);

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function write(line: string): void {
  console.log(line);
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

function describeAction(
  action: OrchestratorAction,
  snapshot: RepositorySnapshot,
  gitHubClient: GitHubClient,
): string {
  const issueTitle = snapshot.issues.find((i) => i.number === action.issueNumber)?.title;
  const issueSuffix = issueTitle ? ` "${issueTitle}"` : "";
  const issueUrl = gitHubClient.issueUrl(action.issueNumber);
  switch (action.type) {
    case "start-implementation":
      return `Start implementation of issue #${action.issueNumber}${issueSuffix} (${issueUrl})`;
    case "request-review":
      return `Request review for PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix}) (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "address-review-comments":
      return `Address ${action.reviewCommentCount} review comment(s) on PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix}) (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "write-final-description":
      return `Write final description for PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix}) (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "merge-pull-request":
      return `Merge PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix}) (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
  }
}

function describeSession(
  session: AgentSession,
  gitHubClient: GitHubClient,
): string {
  const target =
    session.pullRequestNumber !== undefined
      ? `PR #${session.pullRequestNumber} (${gitHubClient.pullRequestUrl(session.pullRequestNumber)})`
      : `issue #${session.issueNumber} (${gitHubClient.issueUrl(session.issueNumber)})`;
  return `${session.phase} · ${session.status} · ${target} · session ${shortId(session.id)}`;
}

interface Config {
  owner: string;
  repo: string;
  token: string;
  maxConcurrency: number;
  intervalMs: number;
  once: boolean;
  dryRun: boolean;
  sessionStorePath: string;
  sessionTimeoutMs: number;
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

  const maxConcurrency = Number.parseInt(process.env.MAX_CONCURRENCY ?? "3", 10);
  const intervalMs = Number.parseInt(process.env.LOOP_INTERVAL_MS ?? "60000", 10);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const sessionTimeoutMs = Number.parseInt(
    process.env.SESSION_TIMEOUT_MS ?? String(DEFAULT_SESSION_TIMEOUT_MS),
    10,
  );
  const sessionStorePath =
    process.env.VIBRATOR_SESSION_STORE_PATH ?? buildDefaultSessionStorePath(owner, repo);

  return {
    owner,
    repo,
    token,
    maxConcurrency: Number.isNaN(maxConcurrency) ? 3 : maxConcurrency,
    intervalMs: Number.isNaN(intervalMs) ? 60000 : intervalMs,
    once,
    dryRun,
    sessionStorePath,
    sessionTimeoutMs: Number.isNaN(sessionTimeoutMs) ? DEFAULT_SESSION_TIMEOUT_MS : sessionTimeoutMs,
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
    (s) => s.status === "queued" || s.status === "in_progress",
  );

  section("Repository snapshot");
  bullet(`${snapshot.issues.length} open issue(s)`);
  bullet(
    `${snapshot.pullRequests.length} open pull request(s)` +
      (snapshot.pullRequests.length > 0
        ? ` (${draftPullRequestCount} draft, ${readyPullRequestCount} ready)`
        : ""),
  );
  bullet(`${preReconcileActiveSessions.length} active agent session(s)`);
  if (preReconcileActiveSessions.length > 0) {
    for (const session of preReconcileActiveSessions) {
      note(`◦ ${describeSession(session, gitHubClient)}`, 2);
    }
  }

  // --- Reconciliation ---------------------------------------------------
  section("Reconciliation");
  const reconcileEvents = await reconcileSessions(gitHubClient, sessionStore, snapshot);
  const completedEvents = reconcileEvents.filter((e) => e.outcome === "completed");
  const failedStaleEvents = reconcileEvents.filter((e) => e.outcome === "failed-stale");
  const failedTimedOut = await sessionStore.failStaleSessions(config.sessionTimeoutMs);

  bullet(`${completedEvents.length} session(s) completed`);
  for (const event of completedEvents) {
    note(`◦ ${describeSession(event.session, gitHubClient)}`, 2);
  }
  bullet(`${failedStaleEvents.length} session(s) failed (stale)`);
  for (const event of failedStaleEvents) {
    const reason =
      event.staleReason === "issue-closed"
        ? "issue no longer open"
        : "Copilot not assigned to issue";
    note(`◦ ${describeSession(event.session, gitHubClient)} — ${reason}`, 2);
  }
  bullet(`${failedTimedOut.length} session(s) timed out`);
  for (const session of failedTimedOut) {
    note(`◦ ${describeSession(session, gitHubClient)}`, 2);
  }

  snapshot.agentSessions = await sessionStore.load();
  const reconciledActiveSessions = snapshot.agentSessions.filter(
    (s) => s.status === "queued" || s.status === "in_progress",
  );
  bullet(`${reconciledActiveSessions.length} session(s) still active`);
  for (const session of reconciledActiveSessions) {
    note(`◦ ${describeSession(session, gitHubClient)}`, 2);
  }

  // --- Plan -------------------------------------------------------------
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
    bullet(`${plan.actions.length} action(s) to execute`);
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i]!;
      note(`[${i + 1}/${plan.actions.length}] → ${describeAction(action, snapshot, gitHubClient)}`, 2);
      try {
        await executeAction(gitHubClient, sessionStore, action, config.dryRun);
        note(`[${i + 1}/${plan.actions.length}] ✓ done${config.dryRun ? " (dry-run)" : ""}`, 2);
      } catch (error) {
        note(`[${i + 1}/${plan.actions.length}] ✗ failed: ${(error as Error).message}`, 2);
      }
    }
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const repositoryUrl = `https://github.com/${config.owner}/${config.repo}`;
  write(HEAVY_RULE);
  write(`vibrator starting · ${timestamp()}`);
  write(`repo: ${config.owner}/${config.repo} (${repositoryUrl})`);
  const modeNotes: string[] = [];
  if (config.once) modeNotes.push("--once");
  if (config.dryRun) modeNotes.push("--dry-run");
  write(
    `interval: ${formatDuration(config.intervalMs)} · concurrency: ${config.maxConcurrency}` +
      (modeNotes.length > 0 ? ` · mode: ${modeNotes.join(", ")}` : ""),
  );
  write(HEAVY_RULE);

  let iterationNumber = 0;
  do {
    iterationNumber++;
    await runIteration(config, iterationNumber);
    if (config.once) {
      blank();
      write(`Done (--once mode). Exiting.`);
      return;
    }

    blank();
    write(`Next iteration in ${formatDuration(config.intervalMs)}.`);
    await delay(config.intervalMs);
  } while (true);
}

main().catch((error: unknown) => {
  console.error(`[${timestamp()}] Fatal error:`, error);
  process.exitCode = 1;
});

interface Config {
  owner: string;
  repo: string;
  token: string;
  maxConcurrency: number;
  intervalMs: number;
  once: boolean;
  dryRun: boolean;
  sessionStorePath: string;
  sessionTimeoutMs: number;
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

  const maxConcurrency = Number.parseInt(process.env.MAX_CONCURRENCY ?? "3", 10);
  const intervalMs = Number.parseInt(process.env.LOOP_INTERVAL_MS ?? "60000", 10);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const sessionTimeoutMs = Number.parseInt(
    process.env.SESSION_TIMEOUT_MS ?? String(DEFAULT_SESSION_TIMEOUT_MS),
    10,
  );
  const sessionStorePath =
    process.env.VIBRATOR_SESSION_STORE_PATH ?? buildDefaultSessionStorePath(owner, repo);

  return {
    owner,
    repo,
    token,
    maxConcurrency: Number.isNaN(maxConcurrency) ? 3 : maxConcurrency,
    intervalMs: Number.isNaN(intervalMs) ? 60000 : intervalMs,
    once,
    dryRun,
    sessionStorePath,
    sessionTimeoutMs: Number.isNaN(sessionTimeoutMs) ? DEFAULT_SESSION_TIMEOUT_MS : sessionTimeoutMs,
  };
}

async function runIteration(config: Config, iterationNumber: number): Promise<void> {
  const repo = `${config.owner}/${config.repo}`;
  const gitHubClient = new GitHubClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
  });
  log(`--- Iteration ${iterationNumber} | ${repo} (${gitHubClient.repositoryUrl()}) | concurrency: ${config.maxConcurrency}${config.dryRun ? " | DRY RUN" : ""} ---`);

  const sessionStore = new FileSessionStore(config.sessionStorePath);

  log("Checking all workflow runs for any awaiting maintainer approval...");
  try {
    const pendingRuns = await gitHubClient.listWorkflowRunsAwaitingApproval();
    log(
      `  Checked workflow runs awaiting approval: found ${pendingRuns.length}.`,
    );
    for (const run of pendingRuns) {
      const label = `run ${run.id} "${run.name || "unnamed"}" [status=${run.status}, event=${run.event}, branch=${run.headBranch || "?"}] (${run.htmlUrl})`;
      if (config.dryRun) {
        log(`  [dry-run] Would approve workflow ${label}.`);
        continue;
      }
      log(`  Approving workflow ${label}...`);
      try {
        const result = await gitHubClient.approveWorkflowRun(run.id);
        if (result.approved) {
          log(`  Approved workflow ${label}.`);
        } else {
          log(`  Skipped workflow ${label}: ${result.reason}`);
        }
      } catch (error) {
        log(`  Failed to approve workflow ${label}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    log(`  Failed to list workflow runs awaiting approval: ${(error as Error).message}`);
  }

  log("Loading snapshot from GitHub...");
  const snapshot = await loadSnapshot(gitHubClient, sessionStore);
  const activeSessions = snapshot.agentSessions.filter(
    (s) => s.status === "queued" || s.status === "in_progress",
  );
  log(
    `Snapshot loaded: ${snapshot.issues.length} open issue(s), ${snapshot.pullRequests.length} PR(s), ${activeSessions.length} active session(s)`,
  );
  if (activeSessions.length > 0) {
    log("Active agent sessions (pre-reconcile):");
    for (const session of activeSessions) {
      log(`  - session ${session.id} | phase=${session.phase} | status=${session.status} | ${describeSessionTarget(session, gitHubClient)}`);
    }
  }

  log("Reconciling sessions...");
  const reconcileEvents = await reconcileSessions(gitHubClient, sessionStore, snapshot);
  for (const event of reconcileEvents) {
    if (event.outcome === "failed-stale") {
      const reason =
        event.staleReason === "issue-closed"
          ? "issue no longer open"
          : "Copilot is not assigned to the issue";
      log(
        `  Failed stale ${event.session.phase} session ${event.session.id} (${reason}): ${describeSessionTarget(event.session, gitHubClient)}`,
      );
    } else {
      log(
        `  Completed ${event.session.phase} session ${event.session.id}: ${describeSessionTarget(event.session, gitHubClient)}`,
      );
    }
  }
  const failedStale = await sessionStore.failStaleSessions(config.sessionTimeoutMs);
  for (const session of failedStale) {
    log(
      `  Failed timed-out ${session.phase} session ${session.id}: ${describeSessionTarget(session, gitHubClient)}`,
    );
  }
  snapshot.agentSessions = await sessionStore.load();
  const reconciledActiveSessions = snapshot.agentSessions.filter(
    (s) => s.status === "queued" || s.status === "in_progress",
  );
  const reconciledCompleted = snapshot.agentSessions.filter((s) => s.status === "completed").length;
  log(`Sessions after reconciliation: ${reconciledActiveSessions.length} active, ${reconciledCompleted} completed`);
  if (reconciledActiveSessions.length > 0) {
    log("Active agent sessions (post-reconcile):");
    for (const session of reconciledActiveSessions) {
      log(`  - session ${session.id} | phase=${session.phase} | status=${session.status} | ${describeSessionTarget(session, gitHubClient)}`);
    }
  }

  const plan = buildPlan(snapshot, config.maxConcurrency);

  const blockedEntries = Object.entries(plan.blockedIssueNumbers);
  if (blockedEntries.length > 0) {
    log("Blocked issues:");
    for (const [blocked, blockers] of blockedEntries) {
      const blockedNumber = Number.parseInt(blocked, 10);
      const blockerSummary = blockers
        .map((n) => `#${n} (${gitHubClient.issueUrl(n)})`)
        .join(", ");
      log(`  - #${blockedNumber} (${gitHubClient.issueUrl(blockedNumber)}) blocked by ${blockerSummary}`);
    }
  }

  if (plan.actions.length === 0) {
    log("No actions to execute.");
  } else {
    log(`${plan.actions.length} action(s) to execute:`);
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i]!;
      log(`  [${i + 1}/${plan.actions.length}] ${describeAction(action, snapshot, gitHubClient)}`);
      await executeAction(gitHubClient, sessionStore, action, config.dryRun);
      log(`  [${i + 1}/${plan.actions.length}] Done.`);
    }
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const repositoryUrl = `https://github.com/${config.owner}/${config.repo}`;
  log(`vibrator starting | repo: ${config.owner}/${config.repo} (${repositoryUrl}) | interval: ${config.intervalMs}ms | concurrency: ${config.maxConcurrency}${config.once ? " | --once" : ""}${config.dryRun ? " | --dry-run" : ""}`);
  let iterationNumber = 0;
  do {
    iterationNumber++;
    await runIteration(config, iterationNumber);
    if (config.once) {
      log("Done (--once mode). Exiting.");
      return;
    }

    const nextMs = config.intervalMs;
    log(`Iteration complete. Next check in ${Math.round(nextMs / 1000)}s.`);
    await delay(nextMs);
  } while (true);
}

main().catch((error: unknown) => {
  console.error(`[${timestamp()}] Fatal error:`, error);
  process.exitCode = 1;
});
