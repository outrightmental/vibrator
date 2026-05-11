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
import type { OrchestratorAction, RepositorySnapshot } from "./types.js";

const DEFAULT_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

function describeAction(action: OrchestratorAction, snapshot: RepositorySnapshot): string {
  const issueTitle = snapshot.issues.find((i) => i.number === action.issueNumber)?.title;
  const issueSuffix = issueTitle ? ` "${issueTitle}"` : "";
  switch (action.type) {
    case "start-implementation":
      return `Start implementation of issue #${action.issueNumber}${issueSuffix}`;
    case "request-review":
      return `Request review for PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix})`;
    case "address-review-comments":
      return `Address ${action.reviewCommentCount} review comment(s) on PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix})`;
    case "write-final-description":
      return `Write final description for PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix})`;
    case "merge-pull-request":
      return `Merge PR #${action.pullRequestNumber} (issue #${action.issueNumber}${issueSuffix})`;
  }
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
  log(`--- Iteration ${iterationNumber} | ${repo} | concurrency: ${config.maxConcurrency}${config.dryRun ? " | DRY RUN" : ""} ---`);

  const gitHubClient = new GitHubClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
  });
  const sessionStore = new FileSessionStore(config.sessionStorePath);

  log("Loading snapshot from GitHub...");
  const snapshot = await loadSnapshot(gitHubClient, sessionStore);
  const activeSessions = snapshot.agentSessions.filter(
    (s) => s.status === "queued" || s.status === "in_progress",
  );
  log(
    `Snapshot loaded: ${snapshot.issues.length} open issue(s), ${snapshot.pullRequests.length} PR(s), ${activeSessions.length} active session(s)`,
  );

  log("Reconciling sessions...");
  await reconcileSessions(gitHubClient, sessionStore, snapshot);
  await sessionStore.failStaleSessions(config.sessionTimeoutMs);
  snapshot.agentSessions = await sessionStore.load();
  const reconciledActive = snapshot.agentSessions.filter(
    (s) => s.status === "queued" || s.status === "in_progress",
  ).length;
  const reconciledCompleted = snapshot.agentSessions.filter((s) => s.status === "completed").length;
  log(`Sessions after reconciliation: ${reconciledActive} active, ${reconciledCompleted} completed`);

  const plan = buildPlan(snapshot, config.maxConcurrency);

  const blockedEntries = Object.entries(plan.blockedIssueNumbers);
  if (blockedEntries.length > 0) {
    const blockedSummary = blockedEntries
      .map(([blocked, blockers]) => `#${blocked} blocked by ${blockers.map((n) => `#${n}`).join(", ")}`)
      .join("; ");
    log(`Blocked issues: ${blockedSummary}`);
  }

  if (plan.actions.length === 0) {
    log("No actions to execute.");
  } else {
    log(`${plan.actions.length} action(s) to execute:`);
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i]!;
      log(`  [${i + 1}/${plan.actions.length}] ${describeAction(action, snapshot)}`);
      await executeAction(gitHubClient, sessionStore, action, config.dryRun);
      log(`  [${i + 1}/${plan.actions.length}] Done.`);
    }
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  log(`vibrator starting | repo: ${config.owner}/${config.repo} | interval: ${config.intervalMs}ms | concurrency: ${config.maxConcurrency}${config.once ? " | --once" : ""}${config.dryRun ? " | --dry-run" : ""}`);
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
