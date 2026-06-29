import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GitHubApiGateway } from "./github-gateway.js";



// ─── Multi-run terminal status board ────────────────────────────────────────

interface StatusSlot {
  label: string;
  startTime: number;
}

/**
 * Manages N updating status lines at the bottom of the terminal (one per
 * concurrent Claude run). On a TTY it uses ANSI cursor movement to redraw the
 * lines in place every 500 ms; on non-TTY output it falls back to plain log
 * lines so CI and piped consumers still see start/done messages.
 */
class StatusBoard {
  private readonly slots = new Map<number, StatusSlot>();
  private nextId = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  private get tty(): boolean {
    return process.stderr.isTTY === true;
  }

  allocate(label: string): number {
    const id = this.nextId++;
    this.slots.set(id, { label, startTime: Date.now() });
    if (this.tty) {
      // Reserve a blank terminal line for this slot.
      process.stderr.write("\n");
      if (!this.timer) {
        this.timer = setInterval(() => { this.redraw(); }, 500);
      }
    } else {
      process.stderr.write(`Claude [${label}] starting…\n`);
    }
    return id;
  }

  free(id: number, doneMessage: string): void {
    if (!this.slots.has(id)) return;
    if (this.tty) {
      const count = this.slots.size;
      if (count === 1) {
        // Last active slot: replace its line in-place and stop.
        this.redrawWithReplacement(id, doneMessage);
      } else {
        // Other slots still running: write done message at top of board and
        // compact remaining live slots below it. This keeps the cursor anchor
        // at `count` lines below the board top so subsequent redraws (which
        // move up `count-1`) land correctly on the first remaining live slot.
        process.stderr.write(`\x1b[${count}A`);
        process.stderr.write(`\r\x1b[2K${doneMessage}\n`);
        for (const [sid, slot] of this.slots) {
          if (sid !== id) {
            process.stderr.write(`\r\x1b[2K${this.renderSlot(slot)}\n`);
          }
        }
      }
    } else {
      process.stderr.write(`${doneMessage}\n`);
    }
    this.slots.delete(id);
    if (this.slots.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private fmtElapsed(startTime: number): string {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  private renderSlot(slot: StatusSlot): string {
    const elapsed = this.fmtElapsed(slot.startTime);
    return `[${elapsed}] Claude [${slot.label}]`;
  }

  private redraw(): void {
    const count = this.slots.size;
    if (count === 0) return;
    process.stderr.write(`\x1b[${count}A`); // cursor up N lines
    for (const slot of this.slots.values()) {
      process.stderr.write(`\r\x1b[2K${this.renderSlot(slot)}\n`);
    }
  }

  private redrawWithReplacement(targetId: number, replacement: string): void {
    const count = this.slots.size;
    if (count === 0) return;
    process.stderr.write(`\x1b[${count}A`);
    for (const [id, slot] of this.slots) {
      const line = id === targetId ? replacement : this.renderSlot(slot);
      process.stderr.write(`\r\x1b[2K${line}\n`);
    }
  }
}

const statusBoard = new StatusBoard();

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local Claude coding-agent client. The default implementation shells out
 * to the `claude` CLI (Claude Code) inside a fresh checkout of the
 * repository / pull request branch so the CLI can read, modify, commit,
 * and (where applicable) push code.
 *
 * Every operation runs synchronously: `vibrator` waits for Claude to
 * finish, then continues the loop. This client opens the PR itself when
 * implementing an issue.
 */
export interface ClaudeAgentClient {
  implementIssue(params: ImplementIssueParams): Promise<ImplementIssueResult>;
  selfReview(params: SelfReviewParams): Promise<SelfReviewResult>;
  resolveMergeConflicts(
    params: ResolveMergeConflictsParams,
  ): Promise<AgentBranchUpdate>;
  addressFailingChecks(
    params: AddressFailingChecksParams,
  ): Promise<AgentBranchUpdate>;
  generateFinalDescription(
    params: GenerateFinalDescriptionParams,
  ): Promise<string>;
}

export interface ImplementIssueParams {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** Default branch name to base the new feature branch on. */
  baseBranch: string;
}

export interface ImplementIssueResult {
  /** Name of the branch the agent pushed commits to (e.g. `vibrator/issue-42-…`). */
  branch: string;
  /** Title for the new pull request. */
  pullRequestTitle: string;
  /** Body for the new pull request. */
  pullRequestBody: string;
  /** SHA of the latest pushed commit on `branch`. */
  headSha: string;
}

export interface UserComment {
  author: string;
  body: string;
  createdAt: string;
  /** Web URL of the comment, so the review can reference it directly. */
  url?: string;
  /** Where the comment came from: "conversation", "review", or "review-thread". */
  kind?: string;
}

export interface SelfReviewParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestBody: string;
  /** Branch the PR is opened from. */
  headRefName: string;
  /** Branch the PR targets. */
  baseRefName: string;
  /** The issue this PR is intended to resolve — used to scope the review. */
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  /** Human comments on the PR (excluding bot comments) that should steer the review. */
  userComments?: ReadonlyArray<UserComment>;
}

export interface SelfReviewResult {
  /**
   * True when the self-review found issues and committed fixes to the
   * branch. False when the code was already satisfactory and nothing was
   * changed.
   */
  madeChanges: boolean;
  /** SHA of the latest commit on the branch after the review pass. */
  headSha: string;
  /**
   * Per-comment narrative emitted by the agent — one entry for each human
   * comment that was fed into the review, in the order they were presented.
   * Empty when the PR had no human comments or the agent emitted no payload.
   */
  commentResponses: SelfReviewCommentResponse[];
}

export interface SelfReviewCommentResponse {
  /** 1-based index matching the order comments were presented to the agent. */
  index: number;
  /** How the agent addressed (or chose not to act on) this comment. */
  response: string;
}

export interface ResolveMergeConflictsParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headRefName: string;
  baseRefName: string;
  /** Human comments on the PR (excluding bot comments) that should steer conflict resolution. */
  userComments?: ReadonlyArray<UserComment>;
}

export interface AddressFailingChecksParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headRefName: string;
  baseRefName: string;
  /** Names + brief log summaries of the failing checks. */
  failingChecks: ReadonlyArray<{
    name: string;
    logExcerpt: string;
  }>;
  /** Human comments on the PR (excluding bot comments) that should steer the fix. */
  userComments?: ReadonlyArray<UserComment>;
}

export interface GenerateFinalDescriptionParams {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestBody: string;
  headRefName: string;
  baseRefName: string;
  closingIssueNumbers: readonly number[];
}

export interface AgentBranchUpdate {
  /** SHA of the latest commit on the branch after the agent pushed. */
  headSha: string;
}

/**
 * Sentinel markers wrapping the final PR description in `claude` CLI
 * output. The CLI typically interleaves the description with tool-call
 * transcript chatter, so we instruct it (via the prompt) to emit the
 * description exactly between these sentinels.
 */
export const FINAL_DESCRIPTION_START_MARKER = "<<<VIBRATOR_PR_BODY_START>>>";
export const FINAL_DESCRIPTION_END_MARKER = "<<<VIBRATOR_PR_BODY_END>>>";

/**
 * Sentinel markers wrapping the JSON implementation-summary payload
 * (PR title + body) the Claude implementer must emit.
 */
export const IMPLEMENTATION_PAYLOAD_START_MARKER = "<<<VIBRATOR_IMPL_START>>>";
export const IMPLEMENTATION_PAYLOAD_END_MARKER = "<<<VIBRATOR_IMPL_END>>>";

/**
 * Sentinel markers wrapping the JSON self-review payload — a per-comment
 * narrative of how each human comment was addressed.
 */
export const SELF_REVIEW_PAYLOAD_START_MARKER = "<<<VIBRATOR_REVIEW_START>>>";
export const SELF_REVIEW_PAYLOAD_END_MARKER = "<<<VIBRATOR_REVIEW_END>>>";

interface ClaudeAgentClientOptions {
  /** Root directory under which per-PR / per-issue checkouts are created. */
  checkoutRootDir?: string;
  /** Path / command for the local `claude` CLI. */
  claudeCommand?: string;
  /** GitHub token used for GitHub API and authenticated git operations. Required unless githubGateway is provided. */
  githubToken?: string;
  /** GitHub REST API base URL. */
  githubApiBaseUrl?: string;
  /** Shared GitHub API gateway for all REST/GraphQL calls. */
  githubGateway?: GitHubApiGateway;
  /** Override repository clone URLs in tests or enterprise deployments. */
  repositoryCloneUrl?: string | ((owner: string, repo: string) => string);
  /** Model to pass to the claude CLI via --model. When omitted, uses the default model. */
  claudeModel?: string;
  /** Model used specifically for commit message generation. Defaults to claude-haiku-4-5-20251001. */
  claudeCommitModel?: string;
  /** Maximum milliseconds the Claude CLI is allowed to run before being killed. Defaults to 30 minutes. */
  claudeTimeoutMs?: number;
}

function defaultCheckoutRootDir(): string {
  return join(homedir(), ".vibrator", "checkouts");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function isRebaseInProgress(
  repoDir: string,
  pathExistsFn: (path: string) => Promise<boolean> = pathExists,
  gitDir: string = join(repoDir, ".git"),
): Promise<boolean> {
  return (
    (await pathExistsFn(join(gitDir, "rebase-merge"))) ||
    (await pathExistsFn(join(gitDir, "rebase-apply")))
  );
}

interface RunCommandOptions {
  cwd?: string;
  input?: string;
  captureStdout?: boolean;
  /** Capture stderr and include it in non-zero-exit error messages. */
  captureStderr?: boolean;
  /** Called with each decoded stdout chunk as it arrives (requires captureStdout: true). */
  onStdoutChunk?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
  /**
   * If set, the child process is killed with SIGTERM (then SIGKILL after 5 s)
   * and the promise rejects with a timeout error after this many milliseconds.
   */
  timeoutMs?: number;
}

class GitAuth {
  constructor(private readonly token: string) {}

  env(baseEnv: NodeJS.ProcessEnv = process.env, authScopeUrls: readonly string[] = []): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const rawCount = env.GIT_CONFIG_COUNT;
    const count = rawCount === undefined ? 0 : Number.parseInt(rawCount, 10);
    const index = Number.isFinite(count) && count >= 0 ? count : 0;
    const authScopes = this.resolveAuthScopes(authScopeUrls);
    // GitHub's git endpoint requires Basic auth; Bearer is only accepted by the REST API.
    const basicCredential = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    env.GIT_CONFIG_COUNT = String(index + authScopes.length);
    authScopes.forEach((scope, offset) => {
      env[`GIT_CONFIG_KEY_${index + offset}`] = `http.${scope}/.extraheader`;
      env[`GIT_CONFIG_VALUE_${index + offset}`] = `AUTHORIZATION: Basic ${basicCredential}`;
    });
    return env;
  }

  private resolveAuthScopes(authScopeUrls: readonly string[]): string[] {
    const scopes = new Set<string>();
    for (const authScopeUrl of authScopeUrls) {
      const scope = this.getHttpScope(authScopeUrl);
      if (scope) {
        scopes.add(scope);
      }
    }
    if (scopes.size === 0) {
      scopes.add("https://github.com");
    }
    return [...scopes];
  }

  private getHttpScope(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return `${parsed.protocol.slice(0, -1)}://${parsed.host}`;
      }
      return undefined;
    } catch {
      const scpLikeMatch = /^[^@]+@([^:]+):/.exec(url);
      if (scpLikeMatch?.[1]) {
        return `https://${scpLikeMatch[1]}`;
      }
      return undefined;
    }
  }
}

/**
 * Upper bound on retained child-process stderr. Only the trailing ~1.5 KB is
 * ever surfaced (in error summaries), so a generous tail is kept and older
 * output is discarded. This prevents a long-running child from accumulating
 * unbounded memory over a run that can last up to an hour.
 */
const MAX_CAPTURED_STDERR_BYTES = 256 * 1024;

/**
 * Every child is spawned `detached: true` so it leads its own process group
 * (whose group id equals the child's pid). The `claude` CLI in turn spawns a
 * whole tree of node workers / MCP servers / Bash tool calls — but it spawns
 * *those* detached too, so each grandchild leads its OWN process group rather
 * than joining claude's. That means signalling claude's group (`kill(-pid)`)
 * does NOT reach them: they survive, reparent to launchd, and keep holding
 * ~1 GB of RAM apiece until the machine runs out of memory. The only reliable
 * teardown is to kill the whole descendant tree by pid.
 *
 * Because a descendant that has already reparented to launchd can no longer be
 * found by walking down from claude's pid, we snapshot each live child's
 * descendant pids on a periodic sweep *while they are still alive* and union
 * them into `childDescendants`. At teardown we SIGKILL every pid we ever saw
 * (a pid stays valid across reparenting), plus a final fresh snapshot, plus
 * claude's own group as a backstop. This registry tracks every live child so a
 * process-exit or termination signal can reap them all before vibrator exits.
 */
const liveChildren = new Set<ChildProcess>();

/** Maps a live child's pid → every descendant pid observed while it ran. */
const childDescendants = new Map<number, Set<number>>();
let descendantSweepTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Read the whole process table once and return a parent→children adjacency map.
 * Uses `ps` synchronously so this is safe to call from a `process.on("exit")`
 * handler (which may only do synchronous work).
 */
function readProcessTree(): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  let stdout: string;
  try {
    const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
    stdout = result.stdout ?? "";
  } catch {
    return childrenByParent;
  }
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }
  return childrenByParent;
}

/** Breadth-first collection of every descendant pid of `rootPid`. */
function descendantsOf(rootPid: number, tree: Map<number, number[]>): number[] {
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of tree.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/** One-shot descendant snapshot for a single root pid. */
function collectDescendantPids(rootPid: number): number[] {
  return descendantsOf(rootPid, readProcessTree());
}

/**
 * Periodically record the descendants of every live child so we still know
 * their pids after they detach and reparent to launchd. One `ps` per tick
 * covers all live children at once.
 */
function sweepDescendants(): void {
  if (childDescendants.size === 0) return;
  const tree = readProcessTree();
  for (const [rootPid, observed] of childDescendants) {
    for (const descendant of descendantsOf(rootPid, tree)) {
      observed.add(descendant);
    }
  }
}

function startTrackingChild(pid: number): void {
  childDescendants.set(pid, new Set());
  if (!descendantSweepTimer) {
    descendantSweepTimer = setInterval(sweepDescendants, 5000);
    // Never let the sweep keep the event loop (and thus the process) alive.
    descendantSweepTimer.unref?.();
  }
}

function stopTrackingChild(pid: number): void {
  childDescendants.delete(pid);
  if (childDescendants.size === 0 && descendantSweepTimer) {
    clearInterval(descendantSweepTimer);
    descendantSweepTimer = undefined;
  }
}

/**
 * Tear a child down completely: SIGKILL every descendant pid we ever observed
 * (plus a fresh snapshot taken now, in case the child is still alive), then the
 * child's own process group as a backstop. Killing grandchildren by pid is what
 * actually stops the ~1 GB-apiece orphans — claude spawns them in their own
 * process groups, so the group-only kill below never reaches them.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;

  const targets = new Set<number>(childDescendants.get(pid));
  for (const descendant of collectDescendantPids(pid)) {
    targets.add(descendant);
  }
  // Kill descendants first so a surviving parent cannot keep spawning more, and
  // before any of them notice the parent is gone and reparent away.
  for (const descendant of targets) {
    try {
      process.kill(descendant, signal);
    } catch {
      // Already gone — nothing to do.
    }
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead — nothing to do.
    }
  }
}

let childCleanupInstalled = false;

/**
 * Install one-time handlers that reap every live child process group when
 * vibrator exits or is asked to terminate. Without this, a graceful shutdown
 * (`process.exit(0)` after Escape/Ctrl-C) and an out-of-band `kill <pid>` both
 * orphan whatever `claude` trees are mid-run. `exit` does only synchronous work
 * (`process.kill` is synchronous), which is exactly what that handler allows.
 */
function ensureChildCleanupHandlers(): void {
  if (childCleanupInstalled) return;
  childCleanupInstalled = true;

  const reapAll = (): void => {
    for (const child of liveChildren) {
      killProcessTree(child, "SIGKILL");
    }
    liveChildren.clear();
  };

  process.on("exit", reapAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      reapAll();
      // Re-raise the default disposition by exiting; 128 + signal number is the
      // conventional code (SIGINT = 2 → 130).
      process.exit(signal === "SIGINT" ? 130 : 0);
    });
  }
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<string> {
  ensureChildCleanupHandlers();
  return new Promise((resolve, reject) => {
    // On Windows a non-captured stream goes to a drained pipe (forwarded to our
    // own stdio below) rather than being inherited. Reason: `detached:false` is
    // not enough on its own — a git child that inherits the parent's
    // console/ConPTY handle for stdout can fail to write to it in any
    // console-less moment and die with "fatal: unknown write failure on
    // standard output" (exit 128), because git's end-of-command check exempts
    // pipes/sockets but NOT console char devices. A real anonymous pipe is a
    // plain kernel handle valid in any process, so git always writes cleanly.
    // POSIX keeps "inherit" — its TTY passthrough (e.g. clone/fetch progress
    // meters) is unaffected and the bug does not occur there.
    const passthrough: "inherit" | "pipe" = process.platform === "win32" ? "pipe" : "inherit";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      // POSIX only: lead our own process group so the whole subtree (claude +
      // its node workers / MCP servers) can be signalled at once via
      // process.kill(-pid) — see killProcessTree. Never detach on Windows:
      // there are no signalable process groups (process.kill(-pid) throws and
      // killProcessTree already falls back to child.kill, so detaching buys
      // nothing) and detached:true sets DETACHED_PROCESS, which severs the
      // child from the console and triggers the write failure described above.
      detached: process.platform !== "win32",
      stdio: [
        options.input !== undefined ? "pipe" : "ignore",
        options.captureStdout ? "pipe" : passthrough,
        options.captureStderr ? "pipe" : passthrough,
      ],
    });
    liveChildren.add(child);
    if (child.pid !== undefined) startTrackingChild(child.pid);

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    if (options.timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true;
        // Kill the entire process group, not just the direct child, so the
        // node worker tree claude spawned underneath dies with it.
        killProcessTree(child, "SIGTERM");
        // Escalate to SIGKILL after 5 s if SIGTERM did not work.
        sigkillTimer = setTimeout(() => {
          killProcessTree(child, "SIGKILL");
        }, 5000);
      }, options.timeoutMs);
    }

    const stdoutChunks: Buffer[] = [];
    // Retain only a bounded tail of stderr: it is only ever read back as a
    // short trailing summary, yet the source can emit far more than fits in
    // memory. Older chunks are dropped once the cap is exceeded.
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    const captureStderrTail = (chunk: Buffer): void => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > MAX_CAPTURED_STDERR_BYTES && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks.shift()!.length;
      }
    };
    if (options.captureStdout) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        options.onStdoutChunk?.(chunk.toString("utf8"));
      });
    } else {
      // Windows passthrough: forward the child's piped stdout to ours so its
      // output still appears, but via a drained pipe instead of an inherited
      // console handle. `end: false` keeps our stdout open after the child's
      // stream closes (otherwise the first finished command closes vibrator's
      // stdout). On POSIX child.stdout is null (inherited), so this is a no-op.
      child.stdout?.pipe(process.stdout, { end: false });
      // A broken downstream (e.g. terminal closed) must not crash vibrator.
      child.stdout?.on("error", () => {});
    }

    if (options.captureStderr && child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        captureStderrTail(chunk);
      });
    } else {
      child.stderr?.pipe(process.stderr, { end: false });
      child.stderr?.on("error", () => {});
    }

    // Reap any process-group stragglers the direct child left behind. `claude`
    // normally tears down its own node-worker / MCP-server tree on exit, but
    // when it doesn't, those grandchildren reparent to launchd and hold ~1 GB
    // apiece (see the killProcessTree note above). Timeouts and vibrator
    // shutdown already group-kill; the *normal completion* and *error* paths
    // did not, so a long overnight run accumulated orphans until the machine
    // ran out of memory. The leader is already gone by the time these fire, so
    // a group SIGKILL only touches surviving members (a no-op when there are
    // none).
    let groupReaped = false;
    const reapGroup = (): void => {
      if (groupReaped) return;
      groupReaped = true;
      killProcessTree(child, "SIGKILL");
      if (child.pid !== undefined) stopTrackingChild(child.pid);
    };

    // The leader exiting does not imply its group is empty: a straggler that
    // inherited our stdout/stderr pipe keeps `close` from firing (it holds the
    // FD open), so reap as soon as the direct child is gone. That kills the
    // pipe-holder, which in turn lets `close` fire and the promise settle —
    // instead of hanging until the run-level timeout.
    child.on("exit", () => {
      reapGroup();
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
      liveChildren.delete(child);
      reapGroup();
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
      liveChildren.delete(child);
      reapGroup();
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");

      const summarizeOutput = (text: string): string => {
        const trimmed = text.trim();
        if (!trimmed) return "";
        const limit = 1500;
        return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed;
      };

      const outputSummary = summarizeOutput(stderrText) || summarizeOutput(stdoutText);

      if (timedOut) {
        reject(
          new Error(
            `Command \`${command} ${args.join(" ")}\` timed out after ${options.timeoutMs! / 1000}s and was killed.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Command \`${command} ${args.join(" ")}\` exited with non-zero status ${code ?? "unknown"}.` +
              (outputSummary ? `\n${outputSummary}` : ""),
          ),
        );
        return;
      }
      resolve(stdoutText);
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

/**
 * Resolves the actual git directory for a repo or linked worktree.
 * In a regular clone, this is `<repoDir>/.git`. In a linked worktree,
 * `.git` is a file so the actual git dir is elsewhere; git resolves it
 * via `--absolute-git-dir`. Falls back to the conventional path on error.
 */
async function getGitDir(repoDir: string): Promise<string> {
  try {
    return (
      await runCommand("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: repoDir,
        captureStdout: true,
      })
    ).trim();
  } catch {
    return join(repoDir, ".git");
  }
}

/**
 * Returns true when `repoDir` is a checkout whose HEAD resolves to a commit.
 *
 * A partial or interrupted clone leaves an unborn HEAD (`ref: refs/heads/main`
 * with no commit), and a linked worktree whose admin entry was pruned can no
 * longer resolve HEAD. In both cases `git reset --hard HEAD` fails with
 * "ambiguous argument 'HEAD'", so the directory must be recreated rather than
 * reused. `git rev-parse --verify HEAD` exits non-zero for these states and
 * zero for a healthy checkout.
 */
async function hasResolvableHead(repoDir: string): Promise<boolean> {
  try {
    await runCommand("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: repoDir,
    });
    return true;
  } catch {
    return false;
  }
}

function extractBetweenMarkers(
  rawOutput: string,
  start: string,
  end: string,
): string | undefined {
  const startIndex = rawOutput.indexOf(start);
  const endIndex = rawOutput.lastIndexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }
  return rawOutput
    .slice(startIndex + start.length, endIndex)
    .replace(/^\s*\r?\n/, "")
    .replace(/\r?\n\s*$/, "")
    .trim();
}

export function extractFinalDescription(rawOutput: string): string {
  const inner = extractBetweenMarkers(
    rawOutput,
    FINAL_DESCRIPTION_START_MARKER,
    FINAL_DESCRIPTION_END_MARKER,
  );
  return inner ?? rawOutput.trim();
}

export function sanitizePullRequestTitle(title: string): string {
  const trimmedInput = title.trim();
  const stripped = trimmedInput.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "");
  const trimmed = stripped.trim();
  if (!trimmed) return trimmedInput;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function extractImplementationPayload(
  rawOutput: string,
): { pullRequestTitle: string; pullRequestBody: string } | undefined {
  const inner = extractBetweenMarkers(
    rawOutput,
    IMPLEMENTATION_PAYLOAD_START_MARKER,
    IMPLEMENTATION_PAYLOAD_END_MARKER,
  );
  if (!inner) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(inner);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const obj = data as Record<string, unknown>;
  if (typeof obj.title !== "string" || typeof obj.body !== "string") {
    return undefined;
  }
  return {
    pullRequestTitle: sanitizePullRequestTitle(obj.title),
    pullRequestBody: obj.body,
  };
}

/**
 * Extracts the per-comment self-review narrative from the agent's raw output.
 * Returns an empty array when no valid payload is present.
 */
export function extractSelfReviewPayload(rawOutput: string): SelfReviewCommentResponse[] {
  const inner = extractBetweenMarkers(
    rawOutput,
    SELF_REVIEW_PAYLOAD_START_MARKER,
    SELF_REVIEW_PAYLOAD_END_MARKER,
  );
  if (!inner) return [];
  let data: unknown;
  try {
    data = JSON.parse(inner);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const raw = (data as Record<string, unknown>).commentResponses;
  if (!Array.isArray(raw)) return [];
  const responses: SelfReviewCommentResponse[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.index !== "number" || typeof obj.response !== "string") continue;
    responses.push({ index: obj.index, response: obj.response });
  }
  return responses;
}

export function formatUserCommentsSection(userComments: ReadonlyArray<UserComment> | undefined): string[] {
  if (!userComments || userComments.length === 0) return [];
  const formatted = userComments.map((c, i) => {
    const meta = [c.createdAt, c.kind, c.url].filter((v) => v).join(" · ");
    return `[Comment ${i + 1}] **${c.author}** (${meta}):\n${c.body}`;
  });
  return [
    "",
    "Human comments on this PR — read every one of them and take it into account when doing your work:",
    "---",
    ...formatted,
    "---",
  ];
}

function buildImplementationPrompt(params: ImplementIssueParams, branch: string): string {
  return [
    `You are implementing GitHub issue #${params.issueNumber} in the repository ${params.owner}/${params.repo}.`,
    "",
    `Issue title: ${params.issueTitle}`,
    "",
    "Issue body:",
    "---",
    params.issueBody || "(empty)",
    "---",
    "",
    "Working directory: the current directory is a checkout of the repository, with",
    `branch \`${branch}\` already checked out (it is based on \`${params.baseBranch}\`).`,
    "",
    "Instructions:",
    `1. Implement the change required by issue #${params.issueNumber}. Read the existing code, make the necessary edits, and add or update tests when relevant.`,
    "2. Commit every change you make to the current branch with descriptive commit messages.",
    "3. After all commits are made, output a JSON object containing the proposed pull-request title and body, wrapped between the exact sentinel lines below.",
    "",
    `${IMPLEMENTATION_PAYLOAD_START_MARKER}`,
    `{`,
    `  "title": "<concise PR title summarizing the change>",`,
    `  "body": "<Markdown PR body describing what changed, why, and how it was tested. Include a 'Closes #${params.issueNumber}' line.>"`,
    `}`,
    `${IMPLEMENTATION_PAYLOAD_END_MARKER}`,
    "",
    "Output requirements:",
    "- The JSON object must be valid and appear exactly once, between the sentinel markers on their own lines.",
    "- Do not wrap the JSON in code fences.",
    "- Anything written outside the sentinels is treated as transcript and discarded.",
    "- The title must be a plain sentence: begin with a capitalized word, state the change directly, and include no prefixes such as 'feat:', 'fix:', 'chore:', or similar conventional-commit annotations.",
  ].join("\n");
}

function buildSelfReviewPrompt(params: SelfReviewParams): string {
  const issueSection =
    params.issueNumber !== undefined
      ? [
          "",
          `This PR was created to resolve issue #${params.issueNumber}: ${params.issueTitle ?? "(no title)"}`,
          "",
          "Issue description:",
          "---",
          params.issueBody || "(empty)",
          "---",
        ]
      : [];

  const commentCount = params.userComments?.length ?? 0;
  const payloadSection =
    commentCount > 0
      ? [
          "",
          `6. You MUST account for every one of the ${commentCount} human comment(s) shown above. After completing your work, emit a JSON payload — wrapped between the exact sentinel lines below, each on its own line — describing how you addressed each comment.`,
          "",
          `${SELF_REVIEW_PAYLOAD_START_MARKER}`,
          `{`,
          `  "commentResponses": [`,
          `    { "index": 1, "response": "<1-2 sentences: what you did in response to Comment 1, or why no change was needed>" }`,
          `  ]`,
          `}`,
          `${SELF_REVIEW_PAYLOAD_END_MARKER}`,
          "",
          "Payload requirements:",
          `- Include exactly one entry per human comment, with \`index\` matching the [Comment N] label shown above (1 through ${commentCount}).`,
          "- `response` must be specific about what changed (reference files/commits) or, if you made no change, explain why the comment did not require one.",
          "- The JSON must be valid, appear exactly once, and not be wrapped in code fences.",
        ]
      : [];

  return [
    `You are performing a self-review of pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `PR title: ${params.pullRequestTitle}`,
    `Branch: \`${params.headRefName}\` (targets \`${params.baseRefName}\`).`,
    ...issueSection,
    "",
    "Current PR description:",
    "---",
    params.pullRequestBody || "(empty)",
    "---",
    ...formatUserCommentsSection(params.userComments),
    "",
    "Instructions:",
    `1. Read the full diff (\`git diff origin/${params.baseRefName}..HEAD\`) and the surrounding code carefully.`,
    `2. Evaluate the changes strictly against the requirements in issue #${params.issueNumber !== undefined ? params.issueNumber : "(above)"}. Only flag problems that are relevant to what this issue asked for: bugs, missing requirements, broken or missing tests, security issues, or significant design problems within the scope of this change. Do not comment on pre-existing code or unrelated areas.`,
    "3. If there are human comments on the PR (shown above), address any requests or concerns raised in them.",
    "4. If you find any problems, fix them directly by editing the files. Commit every change with a clear, descriptive commit message that explains what was changed and why.",
    "5. If you find nothing that needs to change, make no commits and output only a brief 'LGTM' message.",
    ...payloadSection,
    "",
    "Be honest and thorough — this is your own code and the goal is to ship high-quality work that fully satisfies the issue.",
  ].join("\n");
}

function buildResolveConflictsPrompt(params: ResolveMergeConflictsParams): string {
  return [
    `You are resolving merge conflicts on pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `The current branch \`${params.headRefName}\` has been rebased onto \`origin/${params.baseRefName}\` and is in a conflicted state (or about to be — run \`git status\` first).`,
    ...formatUserCommentsSection(params.userComments),
    "",
    "Instructions:",
    "1. Inspect the conflicts (`git status`, `git diff --check`).",
    "2. Resolve each conflict by editing the files so the resulting code is correct and integrates both sides of the merge meaningfully.",
    "3. If there are human comments on the PR (shown above), keep their requests in mind when resolving conflicts.",
    "4. `git add` the resolved files and commit (either continue the rebase with `git rebase --continue` or, if a non-rebase merge is in progress, `git commit`).",
    "5. Do not push — the orchestrator handles pushing.",
    "",
    "If you cannot resolve a conflict safely, abort the rebase/merge (`git rebase --abort` / `git merge --abort`) and exit with a clear explanation.",
  ].join("\n");
}

function buildAddressFailingChecksPrompt(params: AddressFailingChecksParams): string {
  const checkList = params.failingChecks
    .map((c, i) => `### ${i + 1}. ${c.name}\n\n${c.logExcerpt}`)
    .join("\n\n");
  return [
    `Status checks are failing on pull request #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `Branch: \`${params.headRefName}\` (targets \`${params.baseRefName}\`).`,
    "",
    "Failing checks (name + log excerpt):",
    "---",
    checkList || "(no failing-check details were captured — investigate the PR checks in GitHub)",
    "---",
    ...formatUserCommentsSection(params.userComments),
    "",
    "Instructions:",
    "1. Diagnose the failure(s) by reading the code referenced in the logs.",
    "2. Fix the underlying problem. Re-run the tests/linters locally if available.",
    "3. If there are human comments on the PR (shown above), address any requests or concerns raised in them.",
    "4. Commit every change with a descriptive commit message.",
    "5. Do not push — the orchestrator handles pushing.",
  ].join("\n");
}

function buildPushConflictResolutionPrompt(branch: string): string {
  return [
    `A git merge conflict occurred while preparing to push branch \`${branch}\` to origin.`,
    "",
    "The repository is currently in an in-progress merge state.",
    "",
    "Instructions:",
    "1. Run `git status` and inspect all conflicted files.",
    "2. Resolve every conflict carefully, preserving both local and remote intent where appropriate.",
    "3. Stage resolved files with `git add`.",
    "4. Complete the merge by creating a commit (`git commit`) with a clear message.",
    "5. Do not run `git push` yourself; stop after the merge commit succeeds.",
    "",
    "If a safe resolution is not possible, stop and explain why.",
  ].join("\n");
}

function buildFinalDescriptionPrompt(params: GenerateFinalDescriptionParams): string {
  const closingReferences =
    params.closingIssueNumbers.length === 0
      ? ""
      : `\n\nThe final description must end with these closing references on their own lines (inside the markers, before the end marker) so GitHub auto-closes the linked issues:\n${params.closingIssueNumbers
          .map((issueNumber) => `Closes #${issueNumber}`)
          .join("\n")}`;

  return [
    `You are writing the final pull-request description for PR #${params.pullRequestNumber} in ${params.owner}/${params.repo}.`,
    "",
    `Read the commits and diff on the current branch (use \`git log\`, \`git diff origin/${params.baseRefName}..HEAD\`, etc.) and produce a polished, accurate Markdown description summarizing what changed and why.`,
    "",
    `Current PR title: ${params.pullRequestTitle}`,
    "",
    "Current PR description (may be a placeholder — replace as needed):",
    "---",
    params.pullRequestBody || "(empty)",
    "---",
    "",
    "Output requirements:",
    `- Emit the final PR description wrapped between the exact sentinel lines \`${FINAL_DESCRIPTION_START_MARKER}\` and \`${FINAL_DESCRIPTION_END_MARKER}\`, each on its own line.`,
    "- The content between the sentinels MUST be ONLY the Markdown body of the new PR description — no preamble, no recap, no tool transcript, no code fences wrapping the whole thing.",
    "- Do not include the PR title.",
    "- The sentinel markers must appear exactly once each in your entire output.",
    "- Anything you write outside the sentinels will be discarded, so put the complete final description between them.",
    closingReferences,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function slugifyIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const DEFAULT_CLAUDE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_QUOTA_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes

let claudeQuotaBlockedUntilMs: number | undefined;
let claudeTermsAcceptanceRequired = false;

export function getClaudeQuotaBlockedUntilMs(): number | undefined {
  return claudeQuotaBlockedUntilMs;
}

export function isClaudeUsageLimitMessage(message: string): boolean {
  return /out of extra usage|out of usage|hit your limit|rate limit|quota|usage limit/i.test(
    message,
  );
}

export function isClaudeTermsAcceptanceMessage(message: string): boolean {
  return /consumer terms and privacy policy|accept them in claude\.ai|updated our consumer terms/i.test(
    message,
  );
}

export function isNonFastForwardPushError(message: string): boolean {
  return /non-fast-forward|failed to push some refs|tip of your current branch is behind/i.test(
    message,
  );
}

export interface ClaudeAuthResult {
  valid: boolean;
  reason?: string;
}

export async function validateClaudeAuth(): Promise<ClaudeAuthResult> {
  const credentialsPath = join(homedir(), ".claude", ".credentials.json");

  let raw: string;
  try {
    raw = await readFile(credentialsPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { valid: false, reason: "credentials file not found" };
    }
    return { valid: false, reason: `credentials file unreadable: ${(err as Error).message}` };
  }

  let credentials: unknown;
  try {
    credentials = JSON.parse(raw);
  } catch {
    return { valid: false, reason: "credentials file is not valid JSON" };
  }

  const oauth = (credentials as Record<string, unknown>)?.claudeAiOauth as
    | Record<string, unknown>
    | undefined;
  if (oauth) {
    const expiresAt = oauth.expiresAt;
    if (typeof expiresAt === "number" && expiresAt < Date.now()) {
      return { valid: false, reason: "OAuth token has expired" };
    }
  }

  return { valid: true };
}

function isCommandLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return /ENAMETOOLONG|E2BIG/i.test(`${message} ${code}`);
}

export function parseOriginHeadBranch(symbolicRef: string): string | undefined {
  const trimmed = symbolicRef.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("origin/")) {
    const branch = trimmed.slice("origin/".length).trim();
    return branch.length > 0 ? branch : undefined;
  }
  if (trimmed.startsWith("refs/remotes/origin/")) {
    const branch = trimmed.slice("refs/remotes/origin/".length).trim();
    return branch.length > 0 ? branch : undefined;
  }
  return undefined;
}

async function resolveBaseBranch(repoDir: string, preferredBaseBranch?: string): Promise<string> {
  const preferred = preferredBaseBranch?.trim();
  if (preferred) {
    return preferred;
  }

  try {
    const originHead = (
      await runCommand(
        "git",
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        { cwd: repoDir, captureStdout: true },
      )
    ).trim();
    return parseOriginHeadBranch(originHead) ?? "main";
  } catch {
    return "main";
  }
}

/**
 * Parse a quota-reset timestamp from Claude CLI output.
 *
 * Supported examples:
 * - "resets 6:40pm (America/Los_Angeles)"
 * - "reset at 10:15 AM"
 *
 * Returns an epoch-millis timestamp in local time, or undefined if parsing fails.
 */
export function parseUsageResetTimeMs(message: string, now: Date = new Date()): number | undefined {
  const match = message.match(/\breset(?:s)?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap]m)\b/i);
  if (!match) {
    return undefined;
  }

  const rawHour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  const period = match[3]!.toLowerCase();

  if (Number.isNaN(rawHour) || Number.isNaN(minute) || rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
    return undefined;
  }

  const hours24 = (rawHour % 12) + (period === "pm" ? 12 : 0);
  const reset = new Date(now);
  reset.setSeconds(0, 0);
  reset.setHours(hours24, minute, 0, 0);

  if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }

  return reset.getTime();
}

function formatLocalTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    month: "short",
    day: "numeric",
  });
}

function buildPushRecoveryBackupBranchName(branch: string): string {
  const sanitizedBranch = branch
    .replace(/[^a-zA-Z0-9/_-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `vibrator/recovery-${sanitizedBranch || "branch"}-${Date.now()}`;
}

export const DEFAULT_COMMIT_MODEL = "claude-haiku-4-5-20251001";

class DefaultClaudeAgentClient implements ClaudeAgentClient {
  private readonly checkoutRootDir: string;
  private readonly claudeCommand: string;
  private readonly githubToken: string;
  private readonly githubApiBaseUrl: string;
  private readonly githubGateway: GitHubApiGateway;
  private readonly repositoryCloneUrl:
    | string
    | ((owner: string, repo: string) => string)
    | undefined;
  private readonly gitAuth: GitAuth;
  private readonly claudeModel: string | undefined;
  private readonly claudeCommitModel: string;
  private readonly claudeTimeoutMs: number;

  constructor(options: ClaudeAgentClientOptions = {}) {
    this.checkoutRootDir = options.checkoutRootDir ?? defaultCheckoutRootDir();
    this.claudeCommand = options.claudeCommand ?? "claude";
    if (!options.githubToken && !options.githubGateway) {
      throw new Error("ClaudeAgentClient requires either githubToken or githubGateway.");
    }
    this.githubToken = options.githubToken ?? "";
    this.githubApiBaseUrl = options.githubApiBaseUrl ?? "https://api.github.com";
    this.githubGateway =
      options.githubGateway ??
      new GitHubApiGateway({
        token: this.githubToken,
        apiBaseUrl: this.githubApiBaseUrl,
      });
    this.repositoryCloneUrl = options.repositoryCloneUrl;
    this.gitAuth = new GitAuth(this.githubToken);
    this.claudeModel = options.claudeModel;
    this.claudeCommitModel = options.claudeCommitModel ?? DEFAULT_COMMIT_MODEL;
    this.claudeTimeoutMs = options.claudeTimeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
  }

  async implementIssue(params: ImplementIssueParams): Promise<ImplementIssueResult> {
    const branch = `vibrator/issue-${params.issueNumber}-${slugifyIssueTitle(params.issueTitle)}`;
    const repoDir = await this.checkoutBaseBranch({
      owner: params.owner,
      repo: params.repo,
      baseBranch: params.baseBranch,
      identifier: `issue-${params.issueNumber}`,
    });

    const branchAlreadyExistsRemotely = await this.remoteBranchExists(repoDir, branch);
    const branchStartPoint = branchAlreadyExistsRemotely
      ? `origin/${branch}`
      : `origin/${params.baseBranch}`;

    // Create or reset the feature branch from an up-to-date starting point.
    await runCommand("git", ["checkout", "-B", branch, branchStartPoint], {
      cwd: repoDir,
    });

    const prompt = buildImplementationPrompt(params, branch);
    const stdout = await this.runClaude(prompt, repoDir);
    const payload = extractImplementationPayload(stdout);

    // Safety net: if Claude edited files but did not commit them (e.g. because
    // the permission mode previously blocked bash commands), commit everything
    // now so the push is never empty.
    const uncommitted = (
      await runCommand("git", ["status", "--porcelain"], {
        cwd: repoDir,
        captureStdout: true,
      })
    ).trim();
    if (uncommitted) {
      console.warn(
        `[vibrator] Claude left uncommitted changes after implementation — committing automatically.`,
      );
      await runCommand("git", ["add", "--all"], { cwd: repoDir });
      await runCommand(
        "git",
        ["commit", "-m", `Implement #${params.issueNumber}: ${params.issueTitle}`],
        { cwd: repoDir },
      );
    }

    // Guard: if the branch has zero commits ahead of the base, Claude
    // produced no implementation. Fail early instead of pushing an empty
    // branch and hitting a GitHub 422 when we try to open the PR.
    const commitsAhead = (
      await runCommand(
        "git",
        ["rev-list", "--count", `origin/${params.baseBranch}..HEAD`],
        { cwd: repoDir, captureStdout: true },
      )
    ).trim();
    if (commitsAhead === "0") {
      throw new Error(
        `Claude produced no commits for issue #${params.issueNumber} ("${params.issueTitle}"). ` +
        `The branch "${branch}" has no changes relative to "${params.baseBranch}".`,
      );
    }

    // Merge latest from base branch using 'theirs' strategy before pushing.
    await this.runAuthenticatedGit(["fetch", "origin", params.baseBranch], { cwd: repoDir });
    try {
          await runCommand("git", ["merge", `origin/${params.baseBranch}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }

    // Push the branch and capture the head SHA.
    // If this is a fresh start from the base branch (branchAlreadyExistsRemotely
    // was false), force-push on a non-fast-forward rejection: our new commits
    // represent a complete implementation and should replace any stale remote
    // state that appeared between our initial fetch and this push.
    await this.pushWithRemoteBranchMergeRetry(repoDir, ["push", "origin", branch], branch, {
      allowForcePush: !branchAlreadyExistsRemotely,
    });
    const headSha = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, captureStdout: true })
    ).trim();

    return {
      branch,
      pullRequestTitle:
        payload?.pullRequestTitle ?? params.issueTitle,
      pullRequestBody:
        payload?.pullRequestBody ?? `Closes #${params.issueNumber}`,
      headSha,
    };
  }

  async selfReview(params: SelfReviewParams): Promise<SelfReviewResult> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });

    // Capture the head SHA before Claude runs so we can detect whether any
    // commits were made.
    const headShaBeforeReview = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, captureStdout: true })
    ).trim();

    const prompt = buildSelfReviewPrompt(params);
    const stdout = await this.runClaude(prompt, repoDir);
    const commentResponses = extractSelfReviewPayload(stdout);

    // Determine whether Claude actually committed review fixes before the
    // orchestrator merges the latest base branch during push.
    const headShaAfterReview = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, captureStdout: true })
    ).trim();
    const madeChanges = headShaAfterReview !== headShaBeforeReview;

    // Push whatever Claude may have committed and report the new head SHA.
    const update = await this.pushAndReportHead(repoDir, params.headRefName, {
      baseBranch: params.baseRefName,
    });
    return { madeChanges, headSha: update.headSha, commentResponses };
  }

  async resolveMergeConflicts(
    params: ResolveMergeConflictsParams,
  ): Promise<AgentBranchUpdate> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });

    // Begin a rebase onto the (refreshed) base branch so Claude has
    // conflicts to resolve locally. We use a rebase so the resulting
    // branch is fast-forward mergeable on GitHub.
    await this.runAuthenticatedGit(["fetch", "origin", params.baseRefName], { cwd: repoDir });
    try {
      await runCommand("git", ["rebase", `origin/${params.baseRefName}`], {
        cwd: repoDir,
        captureStdout: true,
        captureStderr: true,
      });
      // Rebase finished cleanly — no conflicts (race with the remote).
      // Merge latest from base branch using 'theirs' strategy before pushing.
      await this.runAuthenticatedGit(["fetch", "origin", params.baseRefName], { cwd: repoDir });
      try {
              await runCommand("git", ["merge", `origin/${params.baseRefName}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
      } catch (error) {
        throw new Error(`Failed to merge latest from base branch before push: ${error}`);
      }
      return this.pushAndReportHead(repoDir, params.headRefName, {
        forceWithLease: false,
        baseBranch: params.baseRefName,
      });
    } catch (error) {
      const rebaseInProgress = await isRebaseInProgress(repoDir, pathExists, await getGitDir(repoDir));
      if (!rebaseInProgress) {
        throw new Error(
          `Failed to rebase PR #${params.pullRequestNumber} onto origin/${params.baseRefName}: ${(error as Error).message}`,
        );
      }
      console.log(
        `[vibrator] Rebase onto origin/${params.baseRefName} produced conflicts for PR #${params.pullRequestNumber}; delegating conflict resolution to Claude.`,
      );
    }

    const prompt = buildResolveConflictsPrompt(params);
    await this.runClaude(prompt, repoDir);
    // Merge latest from base branch using 'theirs' strategy before pushing.
    await this.runAuthenticatedGit(["fetch", "origin", params.baseRefName], { cwd: repoDir });
    try {
            await runCommand("git", ["merge", `origin/${params.baseRefName}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }
    return this.pushAndReportHead(repoDir, params.headRefName, {
      forceWithLease: false,
      baseBranch: params.baseRefName,
    });
  }

  async addressFailingChecks(
    params: AddressFailingChecksParams,
  ): Promise<AgentBranchUpdate> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });
    const prompt = buildAddressFailingChecksPrompt(params);
    await this.runClaude(prompt, repoDir);
    return this.pushAndReportHead(repoDir, params.headRefName, {
      baseBranch: params.baseRefName,
    });
  }

  async generateFinalDescription(
    params: GenerateFinalDescriptionParams,
  ): Promise<string> {
    const repoDir = await this.checkoutPullRequest({
      owner: params.owner,
      repo: params.repo,
      pullRequestNumber: params.pullRequestNumber,
    });
    const prompt = buildFinalDescriptionPrompt(params);
    const stdout = await this.runClaude(prompt, repoDir, this.claudeCommitModel);
    return extractFinalDescription(stdout);
  }

  private getRepositoryCloneUrl(owner: string, repo: string): string {
    if (typeof this.repositoryCloneUrl === "function") {
      return this.repositoryCloneUrl(owner, repo);
    }
    return this.repositoryCloneUrl ?? `https://github.com/${owner}/${repo}.git`;
  }

  private runAuthenticatedGit(
    args: readonly string[],
    options: RunCommandOptions = {},
  ): Promise<string> {
    return this.resolveGitAuthScopeUrls(args, options.cwd).then((authScopeUrls) =>
      runCommand("git", args, {
        ...options,
        env: this.gitAuth.env(options.env, authScopeUrls),
      }),
    );
  }

  private async resolveGitAuthScopeUrls(
    args: readonly string[],
    cwd: string | undefined,
  ): Promise<string[]> {
    const authScopeUrls = [this.githubApiBaseUrl];
    if (args[0] === "clone" && args[1]) {
      authScopeUrls.push(args[1]);
    }

    const remoteName =
      cwd && (args[0] === "fetch" || args[0] === "push" || args[0] === "pull") && args[1]
        ? args[1]
        : undefined;
    if (remoteName && cwd) {
      try {
        const remoteUrl = (
          await runCommand("git", ["remote", "get-url", remoteName], {
            cwd,
            captureStdout: true,
          })
        ).trim();
        if (remoteUrl) {
          authScopeUrls.push(remoteUrl);
        }
      } catch {
        // Ignore missing remotes and fall back to API-derived scope.
      }
    }

    return authScopeUrls;
  }

  private async fetchPullRequestForCheckout(
    owner: string,
    repo: string,
    pullRequestNumber: number,
  ): Promise<{
    head: {
      ref: string;
      sha: string;
      repo: {
        clone_url: string;
        full_name: string;
      };
    };
  }> {
    return this.githubGateway.request<{
      head: {
        ref: string;
        sha: string;
        repo: {
          clone_url: string;
          full_name: string;
        };
      };
    }>(`/repos/${owner}/${repo}/pulls/${pullRequestNumber}`, {
      operation: "fetch-pr-checkout-metadata",
    });
  }

  private async ensureCanonicalClone(owner: string, repo: string): Promise<string> {
    const canonicalDir = join(this.checkoutRootDir, `${owner}-${repo}`, "_main");
    await mkdir(canonicalDir, { recursive: true });
    if (!(await pathExists(join(canonicalDir, ".git")))) {
      await this.runAuthenticatedGit([
        "clone",
        this.getRepositoryCloneUrl(owner, repo),
        canonicalDir,
      ]);
    }
    await runCommand(
      "git",
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: canonicalDir },
    );
    await this.runAuthenticatedGit(["fetch", "origin", "--prune"], { cwd: canonicalDir });
    return canonicalDir;
  }

  private async checkoutBaseBranch(params: {
    owner: string;
    repo: string;
    baseBranch: string;
    /** Unique identifier for this checkout (e.g. `issue-42`). Each concurrent
     *  implementation gets its own directory to avoid git ref-lock races. */
    identifier: string;
  }): Promise<string> {
    const canonicalDir = await this.ensureCanonicalClone(params.owner, params.repo);

    const repoDir = join(
      this.checkoutRootDir,
      `${params.owner}-${params.repo}`,
      params.identifier,
    );

    await this.ensureWorktreeCheckout({
      canonicalDir,
      repoDir,
      worktreeRef: `origin/${params.baseBranch}`,
    });

    // A previous run may have been interrupted after Claude edited files but
    // before they were committed or pushed. Discard any leftover state so the
    // subsequent `git checkout -B` can switch branches cleanly.
    await this.resetWorkingTreeToClean(repoDir);
    return repoDir;
  }

  /**
   * Ensures `repoDir` is a usable checkout, creating it as a linked worktree
   * from the canonical clone when it is missing or unusable.
   *
   * An existing checkout is reused only when its HEAD resolves to a commit.
   * Valid regular clones (`.git` is a directory, left over from older versions)
   * keep their own remote-tracking refs and are fetched here; valid linked
   * worktrees (`.git` is a file) share the canonical clone's refs and need no
   * fetch. A missing, partial, or corrupt directory — e.g. an interrupted clone
   * with an unborn HEAD, on which `git reset --hard HEAD` would fail forever —
   * is removed and (re)created as a linked worktree, which shares git objects
   * with _main and avoids a full network clone.
   */
  private async ensureWorktreeCheckout(params: {
    canonicalDir: string;
    repoDir: string;
    /** Ref to detach the worktree at when it must be (re)created. */
    worktreeRef: string;
  }): Promise<void> {
    const { canonicalDir, repoDir, worktreeRef } = params;
    const gitPath = join(repoDir, ".git");

    if ((await pathExists(gitPath)) && (await hasResolvableHead(repoDir))) {
      if ((await stat(gitPath)).isDirectory()) {
        await runCommand(
          "git",
          ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
          { cwd: repoDir },
        );
        await this.runAuthenticatedGit(["fetch", "origin", "--prune"], { cwd: repoDir });
      }
      return;
    }

    if (await pathExists(repoDir)) {
      // maxRetries rides out the transient EBUSY/EPERM Windows throws when a
      // virus scanner or a lingering handle is still touching a file we just
      // released; without it a single locked file aborts the whole checkout.
      await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    // A prior interrupted run can leave a stale worktree registration for this
    // path in the canonical clone's admin dir (`_main/.git/worktrees/<id>`).
    // `prune` clears an unlocked-but-missing entry, but a *locked* one — or a
    // leftover directory git won't clobber — makes a plain `worktree add` fail
    // forever with "is a missing but locked worktree" / "already exists" (exit
    // 128), wedging this checkout until someone runs `git worktree remove` by
    // hand. Deregister the path (best effort), prune, then add with `-f -f`,
    // which overrides a locked/missing registration, so checkout self-heals.
    await runCommand("git", ["worktree", "remove", "--force", repoDir], {
      cwd: canonicalDir,
      captureStderr: true,
    }).catch(() => {
      // The common case: nothing registered at this path, so nothing to clear.
    });
    await runCommand("git", ["worktree", "prune"], { cwd: canonicalDir, captureStderr: true });
    await runCommand(
      "git",
      ["worktree", "add", "--detach", "-f", "-f", repoDir, worktreeRef],
      { cwd: canonicalDir, captureStderr: true },
    );
  }

  private async resetWorkingTreeToClean(repoDir: string): Promise<void> {
    // Resolve the actual git directory — in a linked worktree `.git` is a file
    // pointing elsewhere, so we cannot construct paths under `<repoDir>/.git`.
    const gitDir = await getGitDir(repoDir);
    if (await isRebaseInProgress(repoDir, pathExists, gitDir)) {
      await runCommand("git", ["rebase", "--abort"], { cwd: repoDir });
    }
    if (await pathExists(join(gitDir, "MERGE_HEAD"))) {
      await runCommand("git", ["merge", "--abort"], { cwd: repoDir });
    }
    await runCommand("git", ["reset", "--hard", "HEAD"], { cwd: repoDir });
    // Drop untracked files (e.g. new files Claude created but never committed)
    // while preserving gitignored artifacts like node_modules.
    await runCommand("git", ["clean", "-fd"], { cwd: repoDir });
  }

  private async checkoutPullRequest(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
  }): Promise<string> {
    const canonicalDir = await this.ensureCanonicalClone(params.owner, params.repo);

    const repoDir = join(
      this.checkoutRootDir,
      `${params.owner}-${params.repo}`,
      `pr-${params.pullRequestNumber}`,
    );

    await this.ensureWorktreeCheckout({
      canonicalDir,
      repoDir,
      // A fresh worktree is detached at the canonical HEAD only as a starting
      // point; the PR's actual head commit is checked out below.
      worktreeRef: "HEAD",
    });

    await this.resetWorkingTreeToClean(repoDir);

    const pullRequest = await this.fetchPullRequestForCheckout(
      params.owner,
      params.repo,
      params.pullRequestNumber,
    );
    const localBranchName = `pr-${params.pullRequestNumber}`;
    const headRemoteName =
      pullRequest.head.repo.full_name === `${params.owner}/${params.repo}`
        ? "origin"
        : `pr-${params.pullRequestNumber}-fork`;
    const remoteRef = `refs/remotes/${headRemoteName}/${pullRequest.head.ref}`;

    if (headRemoteName !== "origin") {
      const remotes = (
        await runCommand("git", ["remote"], { cwd: repoDir, captureStdout: true })
      ).split(/\r?\n/);
      if (remotes.includes(headRemoteName)) {
        await runCommand("git", ["remote", "set-url", headRemoteName, pullRequest.head.repo.clone_url], {
          cwd: repoDir,
        });
      } else {
        await runCommand("git", ["remote", "add", headRemoteName, pullRequest.head.repo.clone_url], {
          cwd: repoDir,
        });
      }
    }

    await this.runAuthenticatedGit(
      ["fetch", headRemoteName, `+refs/heads/${pullRequest.head.ref}:${remoteRef}`],
      { cwd: repoDir },
    );
    await runCommand("git", ["checkout", "-B", localBranchName, pullRequest.head.sha], {
      cwd: repoDir,
    });

    return repoDir;
  }

  private async pushAndReportHead(
    repoDir: string,
    branch: string,
    options: { forceWithLease?: boolean; baseBranch?: string } = {},
  ): Promise<AgentBranchUpdate> {
    // Always merge latest from the PR base branch before pushing.
    const baseBranch = await resolveBaseBranch(repoDir, options.baseBranch);
    await this.runAuthenticatedGit(["fetch", "origin", baseBranch], { cwd: repoDir });
    try {
      await runCommand("git", ["merge", `origin/${baseBranch}`, "-X", "theirs", "--no-edit"], { cwd: repoDir });
    } catch (error) {
      throw new Error(`Failed to merge latest from base branch before push: ${error}`);
    }
    const args = ["push", "origin", `HEAD:${branch}`];
    await this.pushWithRemoteBranchMergeRetry(repoDir, args, branch);
    const headSha = (
      await runCommand("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        captureStdout: true,
      })
    ).trim();
    return { headSha };
  }

  private async remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
    try {
      await runCommand(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
        { cwd: repoDir },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async pushWithRemoteBranchMergeRetry(
    repoDir: string,
    pushArgs: readonly string[],
    branch: string,
    options: { allowForcePush?: boolean } = {},
  ): Promise<void> {
    try {
      await this.runAuthenticatedGit(pushArgs, { cwd: repoDir, captureStderr: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNonFastForwardPushError(message)) {
        throw error;
      }
    }

    const backupBranch = buildPushRecoveryBackupBranchName(branch);
    await runCommand("git", ["branch", backupBranch, "HEAD"], { cwd: repoDir });

    if (options.allowForcePush) {
      console.warn(
        `[vibrator] Push for ${branch} was rejected as non-fast-forward. Preserved recovery point at ${backupBranch}; force-pushing because this branch was started fresh and our implementation is authoritative.`,
      );
      await this.runAuthenticatedGit([...pushArgs, "--force"], { cwd: repoDir, captureStderr: true });
      return;
    }

    console.warn(
      `[vibrator] Push for ${branch} was rejected as non-fast-forward. Preserved recovery point at ${backupBranch}; integrating origin/${branch} before retrying.`,
    );

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      await this.runAuthenticatedGit(["fetch", "origin", branch], { cwd: repoDir });

      try {
        await runCommand("git", ["merge", `origin/${branch}`, "--no-edit"], {
          cwd: repoDir,
          captureStderr: true,
        });
      } catch (error) {
        // Resolve the git dir here to correctly check MERGE_HEAD in linked worktrees
        // (where `.git` is a file rather than a directory).
        const gitDir = await getGitDir(repoDir);
        const mergeInProgress = await pathExists(join(gitDir, "MERGE_HEAD"));
        if (!mergeInProgress) {
          throw new Error(
            `Push rejected as non-fast-forward and merge of origin/${branch} failed before retry: ${error}`,
          );
        }

        console.warn(
          `[vibrator] Merge conflict while integrating origin/${branch} before push retry (${attempt}/${maxRetries}); delegating resolution to Claude.`,
        );
        await this.runClaude(buildPushConflictResolutionPrompt(branch), repoDir);

        const stillMerging = await pathExists(join(gitDir, "MERGE_HEAD"));
        if (stillMerging) {
          throw new Error(
            `Claude did not complete merge-conflict resolution for ${branch}; merge is still in progress. Recovery branch: ${backupBranch}`,
          );
        }
      }

      try {
        await this.runAuthenticatedGit(pushArgs, { cwd: repoDir, captureStderr: true });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isNonFastForwardPushError(message) || attempt === maxRetries) {
          throw new Error(
            `Failed to push ${branch} after ${attempt} non-fast-forward recovery attempt(s). Recovery branch: ${backupBranch}. ${message}`,
          );
        }
      }
    }
  }

  private async runClaude(prompt: string, cwd: string, modelOverride?: string): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Use the local Claude Code subscription, not the Anthropic Platform API.
    // Removing ANTHROPIC_API_KEY forces the claude CLI to authenticate via
    // the subscription credentials in ~/.claude/.credentials.json.
    delete env.ANTHROPIC_API_KEY;
    // Avoid Claude subprocesses inheriting Vibrator's GitHub token.
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.VIBRATOR_GITHUB_TOKEN;
    const effectiveModel = modelOverride ?? this.claudeModel;
    const modelArgs = effectiveModel ? ["--model", effectiveModel] : [];

    const startTime = Date.now();

    // Short display name for the model: strip the leading "claude-" prefix so
    // "claude-sonnet-4-5" becomes "sonnet-4-5" and bare names are shown as-is.
    const modelDisplay = (effectiveModel ?? "claude").replace(/^claude-/i, "");

    const formatElapsed = (): string => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const tryBuildQuotaMessage = (message: string): { text: string; blockedUntilMs: number } | undefined => {
      if (!isClaudeUsageLimitMessage(message)) {
        return undefined;
      }

      const blockedUntilMs =
        parseUsageResetTimeMs(message) ?? Date.now() + DEFAULT_QUOTA_BACKOFF_MS;

      const resetLine = message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /reset|out of extra usage/i.test(line));

      const text =
        "Claude CLI usage limit reached" +
        (resetLine ? ` (${resetLine}).` : ".") +
        ` Skipping Claude actions until approximately ${formatLocalTime(blockedUntilMs)} local time.`;

      return { text, blockedUntilMs };
    };

    if (claudeQuotaBlockedUntilMs !== undefined && Date.now() < claudeQuotaBlockedUntilMs) {
      throw new Error(
        `Claude CLI usage limit reached. Skipping Claude actions until approximately ${formatLocalTime(claudeQuotaBlockedUntilMs)} local time.`,
      );
    }

    if (claudeTermsAcceptanceRequired) {
      throw new Error(
        "Claude CLI account action required. Accept the updated Consumer Terms and Privacy Policy at claude.ai using the account shown in `claude /status`, then restart vibrator.",
      );
    }

    const slotId = statusBoard.allocate(modelDisplay);

    const runClaudeCli = (useStdinPrompt: boolean): Promise<string> =>
      runCommand(
        this.claudeCommand,
        [
          "--print",
          "--permission-mode",
          "bypassPermissions",
          ...modelArgs,
          ...(useStdinPrompt ? [] : [prompt]),
        ],
        {
          cwd,
          captureStdout: true,
          captureStderr: true,
          env,
          timeoutMs: this.claudeTimeoutMs,
          ...(useStdinPrompt ? { input: prompt } : {}),
        },
      );

    try {
      let result: string;
      try {
        result = await runClaudeCli(false);
      } catch (error) {
        if (!isCommandLengthError(error)) {
          throw error;
        }
        console.warn(
          `[vibrator] Claude prompt exceeded command-line length limits; retrying via stdin.`,
        );
        result = await runClaudeCli(true);
      }

      statusBoard.free(slotId, `Claude [${modelDisplay}] done [${formatElapsed()}]`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const quotaMessage = tryBuildQuotaMessage(message);
      statusBoard.free(
        slotId,
        quotaMessage
          ? `Claude [${modelDisplay}] quota limit [${formatElapsed()}]`
          : `Claude [${modelDisplay}] error [${formatElapsed()}]`,
      );
      if (quotaMessage) {
        claudeQuotaBlockedUntilMs = quotaMessage.blockedUntilMs;
        throw new Error(quotaMessage.text, { cause: error });
      }
      if (isClaudeTermsAcceptanceMessage(message)) {
        claudeTermsAcceptanceRequired = true;
        throw new Error(
          "Claude CLI account action required. Accept the updated Consumer Terms and Privacy Policy at claude.ai using the account shown in `claude /status`, then restart vibrator.",
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export function createClaudeAgentClient(
  options: ClaudeAgentClientOptions = {},
): ClaudeAgentClient {
  return new DefaultClaudeAgentClient(options);
}

export type { ClaudeAgentClientOptions };
