import { setTimeout as delay } from "node:timers/promises";

import "dotenv/config";

import { executeAction } from "./actions.js";
import { DashboardServer, openBrowser } from "./dashboard-server.js";
import type { SnapshotSummary } from "./dashboard-server.js";
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

// Module-level dashboard broadcaster. The CLI writers below mirror their
// output here so the live web dashboard sees every line the user sees in
// the terminal. Kept module-scoped because the writers are reused across
// many call sites and threading a parameter through each one would be
// invasive and obscure the orchestrator logic.
let dashboard: DashboardServer | undefined;
let currentIterationNumber = 0;
let currentPhase = "Boot";

function setDashboard(server: DashboardServer | undefined): void {
  dashboard = server;
}

function publishLog(level: "info" | "bullet" | "note" | "heavy", indent: number, message: string): void {
  if (!dashboard) return;
  dashboard.publish({
    type: "log",
    iteration: currentIterationNumber,
    phase: currentPhase,
    level,
    indent,
    message,
    timestamp: new Date().toISOString(),
  });
}

const DEFAULT_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ACKNOWLEDGE_TIMEOUT_MS = 10 * 60 * 1000;
const RULE = "─".repeat(80);
const HEAVY_RULE = "═".repeat(80);

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function write(line: string): void {
  console.log(line);
  // Lines composed entirely of box-drawing rule characters are the CLI's
  // visual section dividers — the dashboard already draws section frames,
  // so don't pollute the live feed with them.
  if (/^[─═]+$/.test(line.trim())) return;
  publishLog("info", 0, line);
}

function blank(): void {
  console.log("");
}

function section(title: string): void {
  blank();
  // A "section" in the CLI maps to an SDLC phase in the dashboard. End the
  // previous phase (if any) and start the new one BEFORE writing the title
  // so the section-title log line is attributed to the new phase rather
  // than the previous one in the broadcast feed.
  if (dashboard) {
    if (currentPhase && currentPhase !== "Boot") {
      dashboard.publish({
        type: "phase",
        iteration: currentIterationNumber,
        phase: currentPhase,
        status: "end",
        timestamp: new Date().toISOString(),
      });
    }
    currentPhase = title;
    dashboard.publish({
      type: "phase",
      iteration: currentIterationNumber,
      phase: title,
      status: "start",
      timestamp: new Date().toISOString(),
    });
  } else {
    currentPhase = title;
  }
  write(title);
  console.log(RULE);
}

function bullet(text: string, indent = 1): void {
  const pad = "  ".repeat(indent);
  console.log(`${pad}• ${text}`);
  publishLog("bullet", indent, text);
}

function note(text: string, indent = 1): void {
  const pad = "  ".repeat(indent);
  console.log(`${pad}${text}`);
  publishLog("note", indent, text);
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
    case "address-failing-checks":
      return `Address failing status checks on PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "write-final-description":
      return `Write final description for PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "merge-pull-request":
      return `Merge PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "resolve-conflicts":
      return `Resolve merge conflicts in PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "abandon-empty-pull-request":
      return (
        `Abandon empty draft PR #${action.pullRequestNumber} ` +
        `(${gitHubClient.pullRequestUrl(action.pullRequestNumber)}) and re-assign ` +
        `Copilot to issue #${action.issueNumber}${issueSuffix} ` +
        `(${gitHubClient.issueUrl(action.issueNumber)})`
      );
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
  dashboardHost: string;
  dashboardPort: number;
  dashboardEnabled: boolean;
  openBrowserOnStart: boolean;
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

  const dashboardPortRaw = Number.parseInt(process.env.VIBRATOR_DASHBOARD_PORT ?? "7777", 10);
  const dashboardPort = Number.isNaN(dashboardPortRaw) ? 7777 : dashboardPortRaw;
  const dashboardHost = process.env.VIBRATOR_DASHBOARD_HOST ?? "127.0.0.1";
  const dashboardEnabled =
    !argv.includes("--no-dashboard") && process.env.VIBRATOR_NO_DASHBOARD !== "1";
  const openBrowserOnStart =
    dashboardEnabled &&
    !argv.includes("--no-browser") &&
    process.env.VIBRATOR_NO_BROWSER !== "1";

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
    dashboardHost,
    dashboardPort,
    dashboardEnabled,
    openBrowserOnStart,
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
  const localCopilotChatClient = createLocalCopilotChatClient({
    // Surface every `copilot` CLI request to the CLI output AND the
    // dashboard so a streamed audience sees the show pause on Copilot
    // and resume once it answers.
    onCallStart: (info) => {
      const message = `📡 calling Copilot CLI: ${info.description} — waiting for a response…`;
      note(message);
      if (dashboard) {
        dashboard.publish({
          type: "copilot-call",
          status: "start",
          kind: info.kind,
          description: info.description,
          pullRequestNumber: info.pullRequestNumber,
          timestamp: new Date().toISOString(),
        });
      }
    },
    onCallEnd: (info) => {
      const message = info.ok
        ? `✓ Copilot CLI responded after ${formatDuration(info.durationMs)}`
        : `✗ Copilot CLI failed after ${formatDuration(info.durationMs)}`;
      note(message);
      if (dashboard) {
        dashboard.publish({
          type: "copilot-call",
          status: "end",
          kind: info.kind,
          description: info.description,
          pullRequestNumber: info.pullRequestNumber,
          timestamp: new Date().toISOString(),
          durationMs: info.durationMs,
          ok: info.ok,
        });
      }
    },
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
  if (dashboard) {
    const summary: SnapshotSummary = {
      pullRequests: snapshot.pullRequests.map((pr) => ({
        number: pr.number,
        title: pr.title,
        draft: pr.draft,
        checksStatus: pr.checksStatus,
        headRefName: pr.headRefName,
        hasMergeConflicts: pr.hasMergeConflicts,
        changedFiles: pr.changedFiles,
        url: gitHubClient.pullRequestUrl(pr.number),
        linkedIssueNumbers: pr.linkedIssueNumbers,
      })),
      issues: snapshot.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        type: issue.type,
        assignees: issue.assignees,
        url: gitHubClient.issueUrl(issue.number),
      })),
      agentSessions: snapshot.agentSessions.map((s) => ({
        id: s.id,
        phase: s.phase,
        status: s.status,
        issueNumber: s.issueNumber,
        pullRequestNumber: s.pullRequestNumber,
      })),
      blockedIssueNumbers: {},
    };
    dashboard.setSnapshot(iterationNumber, summary);
  }
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
      case "copilot-review-incomplete":
        reason =
          "Copilot review request completed with no clean-review signal (no Copilot review on the PR — refusing to merge)";
        break;
      case "copilot-review-comments-not-addressed":
        reason = "Copilot ended its turn but review comments are not adequately addressed";
        break;
      case "copilot-did-not-acknowledge":
        reason = "Copilot never acknowledged the request (no start/finish event or eyes reaction)";
        break;
      case "copilot-stopped-with-error":
        reason =
          "Copilot's agent run finished with an error (likely rate-limit or transient failure) before making progress";
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

    // The "Copilot stopped work due to an error" timeline event no longer
    // carries the rate-limit message body — GitHub now surfaces it only in
    // the cloud-agent workflow run logs. Scan recent failed Copilot agent
    // runs on this PR's head branch and apply the same detector to the
    // combined log text so the pause actually triggers.
    try {
      const failureLogs = await gitHubClient.listRecentCopilotAgentFailureLogs(
        pullRequest.headRefName,
      );
      for (const run of failureLogs) {
        // Anchor the detector to the workflow run's finishedAt so old
        // logs don't produce a perpetually-fresh "now + N minutes" window
        // every iteration. (The rate-limit message is emitted near the
        // run's end, so `finishedAt` ≈ when the agent reported it.) Skip
        // detections whose reset instant is already in the past — that
        // rate-limit window has elapsed and is not actionable.
        const runFinishedAt = new Date(run.finishedAt);
        const detection = detectRateLimitMessage(run.logText, runFinishedAt);
        if (!detection) continue;
        if (detection.resetAt.getTime() <= Date.now()) {
          continue;
        }
        if (
          !detectedRateLimitResetAt ||
          detection.resetAt.getTime() > detectedRateLimitResetAt.getTime()
        ) {
          detectedRateLimitResetAt = detection.resetAt;
        }
        note(
          `◦ rate-limit message in workflow run #${run.runId} ("${run.runName}") on PR #${pullRequest.number} — ` +
            `reset at ${detection.resetAt.toISOString()}` +
            (detection.durationWasParsed ? "" : " (fallback window)"),
          2,
        );
      }
    } catch (error) {
      note(
        `◦ failed to scan workflow logs for PR #${pullRequest.number}: ${(error as Error).message}`,
        2,
      );
    }
  }
  if (detectedRateLimitResetAt) {
    await sessionStore.setRateLimitedUntil(detectedRateLimitResetAt);
    if (dashboard) {
      dashboard.publish({
        type: "rate-limit",
        iteration: iterationNumber,
        resetAt: detectedRateLimitResetAt.toISOString(),
        timestamp: new Date().toISOString(),
      });
    }
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

  // Re-publish the snapshot with blocker info filled in so the dashboard's
  // between-cycle "broadcast TV" can show blockers as their own segment.
  if (dashboard) {
    dashboard.setSnapshot(iterationNumber, {
      pullRequests: snapshot.pullRequests.map((pr) => ({
        number: pr.number,
        title: pr.title,
        draft: pr.draft,
        checksStatus: pr.checksStatus,
        headRefName: pr.headRefName,
        hasMergeConflicts: pr.hasMergeConflicts,
        changedFiles: pr.changedFiles,
        url: gitHubClient.pullRequestUrl(pr.number),
        linkedIssueNumbers: pr.linkedIssueNumbers,
      })),
      issues: snapshot.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        type: issue.type,
        assignees: issue.assignees,
        url: gitHubClient.issueUrl(issue.number),
      })),
      agentSessions: snapshot.agentSessions.map((s) => ({
        id: s.id,
        phase: s.phase,
        status: s.status,
        issueNumber: s.issueNumber,
        pullRequestNumber: s.pullRequestNumber,
      })),
      blockedIssueNumbers: plan.blockedIssueNumbers,
    });
  }

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
      const description = describeAction(action, snapshot, gitHubClient);
      note(`[${i + 1}/${plan.actions.length}] → ${description}`, 2);
      if (dashboard) {
        dashboard.publish({
          type: "action",
          iteration: iterationNumber,
          index: i + 1,
          total: plan.actions.length,
          description,
          status: "start",
          timestamp: new Date().toISOString(),
        });
      }
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
        if (dashboard) {
          dashboard.publish({
            type: "action",
            iteration: iterationNumber,
            index: i + 1,
            total: plan.actions.length,
            description,
            status: "done",
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        const message = (error as Error).message;
        note(`[${i + 1}/${plan.actions.length}] ✗ failed: ${message}`, 2);
        if (dashboard) {
          dashboard.publish({
            type: "action",
            iteration: iterationNumber,
            index: i + 1,
            total: plan.actions.length,
            description,
            status: "failed",
            error: message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const repositoryUrl = `https://github.com/${config.owner}/${config.repo}`;
  const modeNotes: string[] = [];
  if (config.once) modeNotes.push("--once");
  if (config.dryRun) modeNotes.push("--dry-run");

  // --- Dashboard (local web broadcast) ---------------------------------
  // Spin up the local HTTP server BEFORE printing any banners so the very
  // first log lines (including "vibrator starting…") also stream into the
  // dashboard's live feed. If it fails to bind (e.g. port collision), log
  // the error and continue headless — the CLI must keep working.
  let dashboardServer: DashboardServer | undefined;
  if (config.dashboardEnabled) {
    dashboardServer = new DashboardServer();
    try {
      const url = await dashboardServer.start(config.dashboardHost, config.dashboardPort);
      setDashboard(dashboardServer);
      dashboardServer.setStartup({
        repo: `${config.owner}/${config.repo}`,
        repositoryUrl,
        mode: modeNotes,
        intervalMs: config.intervalMs,
        concurrency: config.maxConcurrency,
      });
      console.log(`[dashboard] live at ${url}`);
      if (config.openBrowserOnStart) {
        openBrowser(url);
      }
    } catch (error) {
      console.error(`[dashboard] failed to start: ${(error as Error).message}`);
      dashboardServer = undefined;
      setDashboard(undefined);
    }
  }

  // Make sure the dashboard server is closed cleanly on shutdown so the
  // port is freed and SSE clients see EOF instead of hanging connections.
  const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of shutdownSignals) {
    process.once(signal, () => {
      // Close the dashboard cleanly so the port is released and SSE
      // clients see EOF instead of hanging connections. Surface close
      // errors before exiting so they aren't silently swallowed.
      const exit = (code: number): void => {
        process.exit(code);
      };
      dashboardServer?.close().then(
        () => exit(0),
        (error: unknown) => {
          console.error(`[dashboard] error while shutting down:`, error);
          exit(1);
        },
      ) ?? exit(0);
    });
  }

  write(HEAVY_RULE);
  write(`vibrator starting · ${timestamp()}`);
  write(`repo: ${config.owner}/${config.repo} (${repositoryUrl})`);
  write(
    `interval: ${formatDuration(config.intervalMs)} · concurrency: ${config.maxConcurrency}` +
      (modeNotes.length > 0 ? ` · mode: ${modeNotes.join(", ")}` : ""),
  );
  write(HEAVY_RULE);

  let iterationNumber = 0;
  do {
    iterationNumber++;
    currentIterationNumber = iterationNumber;
    currentPhase = "Boot";
    if (dashboardServer) {
      dashboardServer.publish({
        type: "cycle-start",
        iteration: iterationNumber,
        timestamp: new Date().toISOString(),
      });
    }
    try {
      await runIteration(config, iterationNumber);
    } finally {
      if (dashboardServer) {
        const nextCycleAt = config.once ? null : new Date(Date.now() + config.intervalMs);
        dashboardServer.setNextCycleAt(nextCycleAt);
        dashboardServer.publish({
          type: "cycle-end",
          iteration: iterationNumber,
          nextCycleAt: nextCycleAt ? nextCycleAt.toISOString() : null,
        });
      }
    }

    if (config.once) {
      blank();
      write(`Done (--once mode). Exiting.`);
      // Keep the dashboard up so the user can review the broadcast.
      if (dashboardServer && config.dashboardEnabled) {
        write(`[dashboard] still serving at ${dashboardServer.url()} (Ctrl+C to exit)`);
        return;
      }
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

