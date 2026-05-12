import { setTimeout as delay } from "node:timers/promises";

import "dotenv/config";

import { executeAction } from "./actions.js";
import {
  buildDefaultSessionStorePath,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { createLocalCopilotChatClient } from "./local-copilot.js";
import { buildPlan } from "./orchestrator.js";
import { detectRateLimitMessage } from "./rate-limit.js";
import { reconcileSessions } from "./reconcile.js";
import { FileSessionStore } from "./session-store.js";
import type {
  AgentSession,
  OrchestratorAction,
  RepositorySnapshot,
} from "./types.js";

const DEFAULT_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ACKNOWLEDGE_TIMEOUT_MS = 10 * 60 * 1000;
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
  const actionIssueNumber = action.type === "start-implementation" ? action.issueNumber : action.issueNumber;
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
      return `Start implementation of issue #${action.issueNumber}${issueSuffix} (${gitHubClient.issueUrl(action.issueNumber)})`;
    case "request-review":
      return `Request review for PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "address-review-comments":
      return `Address ${action.reviewCommentCount} review comment(s) on PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "write-final-description":
      return `Write final description for PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "merge-pull-request":
      return `Merge PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "resolve-conflicts":
      return `Resolve merge conflicts in PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
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
  maxConcurrency: number;
  intervalMs: number;
  once: boolean;
  dryRun: boolean;
  sessionStorePath: string;
  sessionTimeoutMs: number;
  acknowledgeTimeoutMs: number;
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
  const acknowledgeTimeoutMs = Number.parseInt(
    process.env.COPILOT_ACKNOWLEDGE_TIMEOUT_MS ?? String(DEFAULT_ACKNOWLEDGE_TIMEOUT_MS),
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
    acknowledgeTimeoutMs: Number.isNaN(acknowledgeTimeoutMs)
      ? DEFAULT_ACKNOWLEDGE_TIMEOUT_MS
      : acknowledgeTimeoutMs,
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
  const localCopilotChatClient = createLocalCopilotChatClient();

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

  // --- Rate-limit pause -------------------------------------------------
  // If a previous iteration detected a Copilot rate-limit message and
  // recorded a reset timestamp, refuse to dispatch any GitHub-side work
  // until that window has elapsed. The whole point is to stop spamming
  // the repo with requests that Copilot will immediately reject.
  const rateLimitedUntil = await sessionStore.getRateLimitedUntil();
  if (rateLimitedUntil && rateLimitedUntil.getTime() > Date.now()) {
    section("Rate-limited — skipping iteration");
    bullet(
      `Copilot rate limit in effect until ${rateLimitedUntil.toISOString()} ` +
        `(≈${formatDuration(rateLimitedUntil.getTime() - Date.now())} remaining)`,
    );
    note(
      "vibrator will resume automatically once the window elapses. To clear " +
        "this manually, delete `rateLimitedUntil` from the session store file.",
    );
    return;
  }
  if (rateLimitedUntil && rateLimitedUntil.getTime() <= Date.now()) {
    // Window elapsed — clear the marker so the rest of the iteration runs normally.
    await sessionStore.setRateLimitedUntil(undefined);
  }

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
  const reconcileEvents = await reconcileSessions(
    gitHubClient,
    sessionStore,
    snapshot,
    localCopilotChatClient,
    {
      owner: config.owner,
      repo: config.repo,
      acknowledgeTimeoutMs: config.acknowledgeTimeoutMs,
    },
  );
  const completedEvents = reconcileEvents.filter((e) => e.outcome === "completed");
  const failedStaleEvents = reconcileEvents.filter((e) => e.outcome === "failed-stale");
  const failedTimedOut = await sessionStore.failStaleSessions(config.sessionTimeoutMs);

  bullet(`${completedEvents.length} session(s) completed`);
  for (const event of completedEvents) {
    note(`◦ ${describeSession(event.session, gitHubClient)}`, 2);
  }
  bullet(`${failedStaleEvents.length} session(s) failed (stale)`);
  for (const event of failedStaleEvents) {
    let reason: string;
    switch (event.staleReason) {
      case "issue-closed":
        reason = "issue no longer open";
        break;
      case "copilot-not-assigned":
        reason = "Copilot not assigned to issue";
        break;
      case "copilot-review-failed":
        reason = "Copilot review came back as failed (wasn't able to review)";
        break;
      case "copilot-review-comments-not-addressed":
        reason = "Copilot ended its turn but review comments are not adequately addressed";
        break;
      case "copilot-did-not-acknowledge":
        reason = "Copilot never acknowledged the request (no start/finish event or eyes reaction)";
        break;
      default:
        reason = "unknown reason";
    }
    note(`◦ ${describeSession(event.session, gitHubClient)} — ${reason}`, 2);
    if (event.evaluationRationale) {
      note(`  rationale: ${event.evaluationRationale.split("\n")[0]}`, 4);
    }
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

  // --- Rate-limit detection --------------------------------------------
  // Scan recent "Copilot stopped work" timeline events on every open PR
  // for the rate-limit message ("You've hit your rate limit. Please wait
  // for your limit to reset in N minutes…"). If detected, persist the
  // reset time and skip plan execution — the next iteration will see the
  // pause and short-circuit immediately.
  section("Copilot rate-limit check");
  let detectedRateLimitResetAt: Date | undefined;
  for (const pullRequest of snapshot.pullRequests) {
    try {
      const stoppedEvents = await gitHubClient.listCopilotStoppedWorkEvents(
        pullRequest.number,
      );
      for (const event of stoppedEvents) {
        const detection = detectRateLimitMessage(event.message);
        if (!detection) continue;
        if (
          !detectedRateLimitResetAt ||
          detection.resetAt.getTime() > detectedRateLimitResetAt.getTime()
        ) {
          detectedRateLimitResetAt = detection.resetAt;
        }
        note(
          `◦ rate-limit message on PR #${pullRequest.number} (${gitHubClient.pullRequestUrl(pullRequest.number)}) — ` +
            `reset at ${detection.resetAt.toISOString()}` +
            (detection.durationWasParsed ? "" : " (fallback window)"),
          2,
        );
      }
    } catch (error) {
      note(
        `◦ failed to scan PR #${pullRequest.number} timeline: ${(error as Error).message}`,
        2,
      );
    }
  }
  if (detectedRateLimitResetAt) {
    await sessionStore.setRateLimitedUntil(detectedRateLimitResetAt);
    bullet(
      `pausing until ${detectedRateLimitResetAt.toISOString()} ` +
        `(≈${formatDuration(detectedRateLimitResetAt.getTime() - Date.now())} from now)`,
    );
    note(
      "Skipping plan execution this iteration. Subsequent iterations will be " +
        "skipped until the window elapses.",
    );
    return;
  }
  bullet("no active rate-limit messages detected");

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
        await executeAction(
          gitHubClient,
          sessionStore,
          action,
          config.dryRun,
          localCopilotChatClient,
          { owner: config.owner, repo: config.repo },
        );
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

