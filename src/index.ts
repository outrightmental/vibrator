import { setTimeout as delay } from "node:timers/promises";

import { executeAction } from "./actions.js";
import {
  buildDefaultSessionStorePath,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { buildPlan } from "./orchestrator.js";
import { reconcileSessions } from "./reconcile.js";
import { FileSessionStore } from "./session-store.js";

const DEFAULT_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

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

async function runIteration(config: Config): Promise<void> {
  const gitHubClient = new GitHubClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
  });
  const sessionStore = new FileSessionStore(config.sessionStorePath);
  const snapshot = await loadSnapshot(gitHubClient, sessionStore);
  await reconcileSessions(gitHubClient, sessionStore, snapshot);
  await sessionStore.failStaleSessions(config.sessionTimeoutMs);
  snapshot.agentSessions = await sessionStore.load();
  const plan = buildPlan(snapshot, config.maxConcurrency);

  console.log(
    JSON.stringify(
      {
        repository: `${config.owner}/${config.repo}`,
        maxConcurrency: config.maxConcurrency,
        actions: plan.actions,
        blockedIssueNumbers: plan.blockedIssueNumbers,
      },
      null,
      2,
    ),
  );

  for (const action of plan.actions) {
    await executeAction(gitHubClient, sessionStore, action, config.dryRun);
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  do {
    await runIteration(config);
    if (config.once) {
      return;
    }

    await delay(config.intervalMs);
  } while (true);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
