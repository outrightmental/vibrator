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
    case "review-pull-request":
      return `Review PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "address-review-comments":
      return `Address ${action.unresolvedReviewCommentCount} review comment(s) on PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "address-failing-checks":
      return `Address failing status checks on PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "write-final-description":
      return `Write final description and squash-merge PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
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
    (s) => s.status === "in_progress",
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
      const actionContext = {
        owner: config.owner,
        repo: config.repo,
        issues: snapshot.issues,
        pullRequests: snapshot.pullRequests,
      };

      const results = await Promise.allSettled(
        plan.actions.map((action) =>
          executeAction(
            gitHubClient,
            sessionStore,
            claudeAgentClient,
            action,
            false,
            actionContext,
          ),
        ),
      );

      blank();
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const prefix = `[${i + 1}/${plan.actions.length}]`;
        if (result.status === "fulfilled") {
          const actionResult: ExecuteActionResult = result.value;
          if (actionResult.noCommitsPushed) {
            note(`${prefix} ⚠ done — no new commits pushed to branch (Claude ran but made no changes)`, 2);
          } else {
            note(`${prefix} ✓ done`, 2);
          }
        } else {
          note(
            `${prefix} ✗ failed: ${(result.reason as Error).message}`,
            2,
          );
        }
      }
    } else {
      blank();
      for (let i = 0; i < plan.actions.length; i++) {
        note(`[${i + 1}/${plan.actions.length}] ✓ done (dry-run)`, 2);
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
