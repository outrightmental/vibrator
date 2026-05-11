import { setTimeout as delay } from "node:timers/promises";

import {
  buildDefaultSessionStorePath,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { buildMergedPullRequestBody, buildPlan } from "./orchestrator.js";
import { FileSessionStore } from "./session-store.js";
import type { OrchestratorAction } from "./types.js";

interface Config {
  owner: string;
  repo: string;
  token: string;
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

  const maxConcurrency = Number.parseInt(process.env.MAX_CONCURRENCY ?? "3", 10);
  const intervalMs = Number.parseInt(process.env.LOOP_INTERVAL_MS ?? "60000", 10);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
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
  };
}

async function executeAction(
  gitHubClient: GitHubClient,
  sessionStore: FileSessionStore,
  action: OrchestratorAction,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    return;
  }

  switch (action.type) {
    case "start-implementation":
      await gitHubClient.createIssueComment(
        action.issueNumber,
        "@copilot Please implement this issue in a pull request using automatic model selection.",
      );
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        phase: "implementation",
      });
      return;
    case "request-review":
      await gitHubClient.createIssueComment(
        action.pullRequestNumber,
        "@copilot Please review this pull request using automatic model selection.",
      );
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "review",
      });
      return;
    case "address-review-comments":
      await gitHubClient.createIssueComment(
        action.pullRequestNumber,
        `@copilot Please address every review comment in this pull request and push the changes. (${action.reviewCommentCount} review comments were found.)`,
      );
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "address-review-comments",
      });
      return;
    case "write-final-description":
      await gitHubClient.createIssueComment(
        action.pullRequestNumber,
        `@copilot Please write the final pull request description based on the final commits in this pull request and include "Closes #${action.issueNumber}".`,
      );
      await sessionStore.createSession({
        issueNumber: action.issueNumber,
        pullRequestNumber: action.pullRequestNumber,
        phase: "final-description",
      });
      return;
    case "merge-pull-request":
      await gitHubClient.updatePullRequestBody(
        action.pullRequestNumber,
        buildMergedPullRequestBody(action.pullRequestBody, action.issueNumber),
      );
      await gitHubClient.mergePullRequest(action.pullRequestNumber);
      return;
  }
}

async function runIteration(config: Config): Promise<void> {
  const gitHubClient = new GitHubClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
  });
  const sessionStore = new FileSessionStore(config.sessionStorePath);
  const snapshot = await loadSnapshot(gitHubClient, sessionStore);
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
