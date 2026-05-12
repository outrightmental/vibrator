import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * Events streamed from the orchestrator loop to the dashboard front-end via
 * Server-Sent Events. The dashboard renders them as a continuous cyberpunk
 * broadcast: a banner + per-phase segments while an SDLC cycle is running,
 * and a "broadcast TV" rotation of GitHub activity in between cycles.
 */
export type DashboardEvent =
  | { type: "startup"; repo: string; repositoryUrl: string; mode: string[]; intervalMs: number; concurrency: number }
  | { type: "cycle-start"; iteration: number; timestamp: string }
  | { type: "cycle-end"; iteration: number; nextCycleAt: string | null }
  | { type: "phase"; iteration: number; phase: string; status: "start" | "end"; timestamp: string }
  | { type: "log"; iteration: number; phase: string; level: "info" | "bullet" | "note" | "heavy"; indent: number; message: string; timestamp: string }
  | { type: "snapshot"; iteration: number; summary: SnapshotSummary; timestamp: string }
  | { type: "action"; iteration: number; index: number; total: number; description: string; status: "start" | "done" | "failed"; error?: string; timestamp: string }
  | { type: "rate-limit"; iteration: number; resetAt: string | null; timestamp: string }
  | { type: "countdown"; nextCycleAt: string | null }
  /**
   * Emitted when the orchestrator is about to call out to the local
   * `copilot` CLI ({@link status} === "start") and again when the call
   * settles ({@link status} === "end"). The dashboard turns this into a
   * full-screen "AWAITING RESPONSE FROM COPILOT CLI" overlay so a
   * streamed audience can see when the show is paused on Copilot.
   */
  | {
      type: "copilot-call";
      status: "start" | "end";
      kind: string;
      description: string;
      pullRequestNumber: number;
      timestamp: string;
      durationMs?: number;
      ok?: boolean;
    };

export interface SnapshotSummary {
  /** All open pull requests, as rendered by the front-end's "now playing" carousel. */
  pullRequests: Array<{
    number: number;
    title: string;
    draft: boolean;
    checksStatus: string;
    headRefName: string;
    hasMergeConflicts: boolean;
    changedFiles: number;
    url: string;
    linkedIssueNumbers: number[];
  }>;
  issues: Array<{
    number: number;
    title: string;
    type: string | null;
    assignees: string[];
    url: string;
  }>;
  agentSessions: Array<{
    id: string;
    phase: string;
    status: string;
    issueNumber: number | undefined;
    pullRequestNumber: number | undefined;
  }>;
  blockedIssueNumbers: Record<number, number[]>;
}

const MAX_HISTORY = 500;

interface DashboardState {
  startedAt: string;
  repo: string | null;
  repositoryUrl: string | null;
  mode: string[];
  intervalMs: number;
  concurrency: number;
  nextCycleAt: string | null;
  currentIteration: number;
  currentPhase: string | null;
  inCycle: boolean;
  snapshot: SnapshotSummary | null;
  rateLimitedUntil: string | null;
}

/**
 * Local HTTP server that exposes the cyberpunk broadcast dashboard.
 *
 * The orchestrator pushes structured events into `publish()`; the server
 * keeps a rolling history so that browsers connecting mid-stream can
 * immediately replay recent context, then receive live updates over SSE.
 */
export class DashboardServer {
  private readonly httpServer: Server;
  private readonly history: DashboardEvent[] = [];
  private readonly clients: Set<ServerResponse> = new Set();
  private state: DashboardState;
  private startedListening = false;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor() {
    this.state = {
      startedAt: new Date().toISOString(),
      repo: null,
      repositoryUrl: null,
      mode: [],
      intervalMs: 0,
      concurrency: 0,
      nextCycleAt: null,
      currentIteration: 0,
      currentPhase: null,
      inCycle: false,
      snapshot: null,
      rateLimitedUntil: null,
    };
    this.httpServer = createServer((request, response) => this.handleRequest(request, response));
  }

  /**
   * Bind to `host:port` and resolve to the live URL. Pass `port = 0` to
   * let the OS pick a free port (used by tests).
   */
  async start(host: string, port: number): Promise<string> {
    if (this.startedListening) {
      throw new Error("DashboardServer is already started");
    }
    // Set the flag only AFTER `listen()` succeeds; if the bind fails (e.g.
    // EADDRINUSE) we want to allow the caller to retry on another port
    // rather than be permanently locked out by a stale flag.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.httpServer.off("error", onError);
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(port, host);
    });
    this.startedListening = true;

    // Periodic keepalive so SSE connections don't get killed by idle proxies
    // and so countdown ticks stay smooth even without orchestrator activity.
    this.heartbeat = setInterval(() => {
      this.broadcastRaw(`: keepalive ${Date.now()}\n\n`);
    }, 15000);
    // Don't keep the process alive solely on the dashboard timer.
    this.heartbeat.unref?.();

    return this.url();
  }

  /** Live URL (host + port the OS bound). */
  url(): string {
    const address = this.httpServer.address() as AddressInfo | null;
    if (!address) {
      throw new Error("DashboardServer is not listening");
    }
    const host = address.address === "::" || address.address === "0.0.0.0" ? "localhost" : address.address;
    return `http://${host}:${address.port}/`;
  }

  /** Stop the server and disconnect every SSE client. */
  async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  setStartup(info: {
    repo: string;
    repositoryUrl: string;
    mode: string[];
    intervalMs: number;
    concurrency: number;
  }): void {
    this.state.repo = info.repo;
    this.state.repositoryUrl = info.repositoryUrl;
    this.state.mode = info.mode;
    this.state.intervalMs = info.intervalMs;
    this.state.concurrency = info.concurrency;
    this.publish({
      type: "startup",
      repo: info.repo,
      repositoryUrl: info.repositoryUrl,
      mode: info.mode,
      intervalMs: info.intervalMs,
      concurrency: info.concurrency,
    });
  }

  setNextCycleAt(nextCycleAt: Date | null): void {
    this.state.nextCycleAt = nextCycleAt ? nextCycleAt.toISOString() : null;
    this.publish({
      type: "countdown",
      nextCycleAt: this.state.nextCycleAt,
    });
  }

  setSnapshot(iteration: number, summary: SnapshotSummary): void {
    this.state.snapshot = summary;
    this.publish({
      type: "snapshot",
      iteration,
      summary,
      timestamp: new Date().toISOString(),
    });
  }

  /** Push an event to all subscribers and to the replay history. */
  publish(event: DashboardEvent): void {
    // Mirror the most relevant signals into the canonical dashboard state
    // so a fresh client can render the UI immediately from `/state`.
    switch (event.type) {
      case "cycle-start":
        this.state.inCycle = true;
        this.state.currentIteration = event.iteration;
        this.state.currentPhase = null;
        break;
      case "cycle-end":
        this.state.inCycle = false;
        this.state.currentPhase = null;
        if (event.nextCycleAt !== undefined) {
          this.state.nextCycleAt = event.nextCycleAt;
        }
        break;
      case "phase":
        if (event.status === "start") {
          this.state.currentPhase = event.phase;
        } else if (this.state.currentPhase === event.phase) {
          this.state.currentPhase = null;
        }
        break;
      case "rate-limit":
        this.state.rateLimitedUntil = event.resetAt;
        break;
      case "countdown":
        this.state.nextCycleAt = event.nextCycleAt;
        break;
      default:
        break;
    }

    this.history.push(event);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    this.broadcastRaw(frame);
  }

  /** Number of currently-connected SSE clients (used by tests). */
  clientCount(): number {
    return this.clients.size;
  }

  private broadcastRaw(frame: string): void {
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        // The next write loop will clean dead clients via 'close' handlers.
      }
    }
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    // Strip query strings (e.g. cache-busted asset URLs like `/app.js?v=…`)
    // before routing so requests don't fall through to 404.
    const rawUrl = request.url ?? "/";
    const queryIndex = rawUrl.indexOf("?");
    const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.end(renderIndexHtml());
      return;
    }
    if (pathname === "/app.js") {
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.end(renderAppJs());
      return;
    }
    if (pathname === "/styles.css") {
      response.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.end(renderStylesCss());
      return;
    }
    if (pathname === "/state") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.end(JSON.stringify({ state: this.state, history: this.history }));
      return;
    }
    if (pathname === "/events") {
      this.handleSse(request, response);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  }

  private handleSse(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Prime the stream so curl/EventSource clients see something immediately.
    response.write(`retry: 2000\n\n`);

    // Hand the new client the current canonical state so the UI can render
    // without waiting for the next orchestrator tick.
    response.write(`event: state\ndata: ${JSON.stringify(this.state)}\n\n`);
    for (const past of this.history) {
      response.write(`event: ${past.type}\ndata: ${JSON.stringify(past)}\n\n`);
    }

    this.clients.add(response);
    const cleanup = (): void => {
      this.clients.delete(response);
    };
    request.on("close", cleanup);
    request.on("error", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
  }
}

/**
 * Best-effort cross-platform "open a URL in the user's default browser".
 * Failures are non-fatal — the orchestrator must keep running even if no
 * browser is available (headless boxes, CI, SSH sessions, etc.).
 */
export function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    // The empty "" arg is the window title that `start` expects when the
    // URL itself is quoted; without it, start treats the URL as the title.
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // Swallow — no browser available is not a fatal condition.
    });
    child.unref();
  } catch {
    // Same here — we never want a missing browser to crash the orchestrator.
  }
}

function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=1280, initial-scale=1" />
  <title>VIBRATOR // LIVE BROADCAST</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="crt">
    <div class="scanlines"></div>
    <div class="grid"></div>
    <header class="topbar">
      <div class="brand">
        <span class="logo">▮▮▮</span>
        <span class="brand-name">VIBRATOR</span>
        <span class="brand-sub">// AI SDLC LIVE</span>
      </div>
      <div class="repo" id="repo-info">—</div>
      <div class="countdown-block">
        <div class="countdown-label">NEXT CYCLE</div>
        <div class="countdown" id="countdown">--:--</div>
      </div>
    </header>

    <main class="stage">
      <section class="banner" id="banner" hidden>
        <div class="banner-bg"></div>
        <div class="banner-text">
          <div class="banner-kicker">⟁ SDLC CYCLE INITIATED</div>
          <div class="banner-title" id="banner-title">CYCLE</div>
          <div class="banner-sub" id="banner-sub"></div>
        </div>
      </section>

      <section class="phase-pane" id="phase-pane" hidden>
        <div class="phase-header">
          <div class="phase-kicker">NOW BROADCASTING</div>
          <div class="phase-title" id="phase-title">—</div>
          <div class="phase-meta" id="phase-meta"></div>
        </div>
        <div class="phase-feed" id="phase-feed"></div>
      </section>

      <section class="tv-pane" id="tv-pane">
        <div class="tv-header">
          <div class="tv-kicker">⌗ BETWEEN-CYCLE BROADCAST</div>
          <div class="tv-title">GITHUB ACTIVITY UPLINK</div>
        </div>
        <div class="tv-stage" id="tv-stage">
          <div class="tv-card placeholder">
            <div class="tv-card-title">STAND BY</div>
            <div class="tv-card-body">Synchronising with the mainframe…</div>
          </div>
        </div>
        <div class="tv-scoreboard" id="tv-scoreboard"></div>
      </section>

      <section class="copilot-overlay" id="copilot-overlay" hidden>
        <div class="copilot-bg"></div>
        <div class="copilot-card">
          <div class="copilot-kicker" id="copilot-kicker">📡 OUTBOUND TRANSMISSION</div>
          <div class="copilot-title">AWAITING RESPONSE<br/>FROM COPILOT CLI</div>
          <div class="copilot-sub" id="copilot-sub">—</div>
          <div class="copilot-bars">
            <span></span><span></span><span></span><span></span><span></span>
            <span></span><span></span><span></span><span></span><span></span>
          </div>
          <div class="copilot-elapsed" id="copilot-elapsed">00:00</div>
        </div>
      </section>
    </main>

    <footer class="lower-third">
      <div class="ticker" id="ticker">
        <div class="ticker-track" id="ticker-track">▮ NO SIGNAL YET — WAITING FOR THE MAINFRAME…</div>
      </div>
    </footer>
  </div>
  <script src="/app.js" defer></script>
</body>
</html>
`;
}

function renderStylesCss(): string {
  return `:root {
  --bg: #05060f;
  --bg-2: #0a0d1f;
  --neon-cyan: #00f0ff;
  --neon-magenta: #ff2bd6;
  --neon-pink: #ff3b6b;
  --neon-yellow: #f6ff00;
  --neon-green: #39ff88;
  --text: #d8f4ff;
  --text-dim: #6fb3c8;
  --danger: #ff3b3b;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "JetBrains Mono", "Fira Code", "Consolas", "Menlo", ui-monospace, monospace;
  overflow: hidden;
  height: 100vh;
  width: 100vw;
}
[hidden] { display: none !important; }
.crt {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: grid;
  grid-template-rows: 96px 1fr 56px;
  background:
    radial-gradient(ellipse at top, rgba(0,240,255,0.10), transparent 60%),
    radial-gradient(ellipse at bottom, rgba(255,43,214,0.10), transparent 60%),
    linear-gradient(180deg, #04050d 0%, #07091a 100%);
  overflow: hidden;
}
.scanlines {
  pointer-events: none;
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    rgba(255,255,255,0.04) 0px,
    rgba(255,255,255,0.04) 1px,
    transparent 2px,
    transparent 4px
  );
  mix-blend-mode: overlay;
  z-index: 50;
  animation: flicker 7s infinite;
}
.grid {
  pointer-events: none;
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(0,240,255,0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,240,255,0.07) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 90%);
  z-index: 1;
}
@keyframes flicker {
  0%, 100% { opacity: 1; }
  48% { opacity: 0.95; }
  50% { opacity: 0.7; }
  52% { opacity: 0.95; }
}

/* TOPBAR */
.topbar {
  position: relative;
  z-index: 5;
  display: grid;
  grid-template-columns: 1fr 2fr 1fr;
  align-items: center;
  padding: 0 28px;
  border-bottom: 1px solid rgba(0,240,255,0.25);
  background: linear-gradient(180deg, rgba(0,240,255,0.06), transparent);
}
.brand { display: flex; align-items: center; gap: 12px; }
.logo {
  color: var(--neon-magenta);
  text-shadow: 0 0 8px var(--neon-magenta);
  letter-spacing: 2px;
  font-size: 22px;
}
.brand-name {
  font-weight: 800;
  font-size: 28px;
  letter-spacing: 6px;
  color: var(--neon-cyan);
  text-shadow: 0 0 8px var(--neon-cyan), 0 0 16px rgba(0,240,255,0.4);
}
.brand-sub { color: var(--text-dim); letter-spacing: 4px; font-size: 12px; }
.repo {
  text-align: center;
  letter-spacing: 2px;
  color: var(--text);
  font-size: 14px;
  text-transform: uppercase;
  opacity: 0.85;
}
.countdown-block { text-align: right; }
.countdown-label {
  color: var(--text-dim);
  letter-spacing: 4px;
  font-size: 11px;
}
.countdown {
  font-size: 36px;
  font-weight: 700;
  letter-spacing: 4px;
  color: var(--neon-yellow);
  text-shadow: 0 0 12px var(--neon-yellow);
}
.countdown.live {
  color: var(--neon-green);
  text-shadow: 0 0 12px var(--neon-green);
}

/* STAGE */
.stage {
  position: relative;
  z-index: 5;
  padding: 24px;
  overflow: hidden;
}

/* BANNER (fly-in on cycle start) */
.banner {
  position: absolute;
  inset: 24px;
  display: grid;
  place-items: center;
  z-index: 30;
  pointer-events: none;
  animation: bannerIn 800ms cubic-bezier(0.2, 0.9, 0.2, 1.05);
}
.banner.exit { animation: bannerOut 600ms ease-out forwards; }
.banner-bg {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(255,43,214,0.15), rgba(0,240,255,0.15)),
    repeating-linear-gradient(45deg, rgba(0,240,255,0.06) 0 12px, transparent 12px 24px);
  border: 2px solid var(--neon-magenta);
  box-shadow: 0 0 40px rgba(255,43,214,0.5) inset, 0 0 40px rgba(0,240,255,0.4);
  filter: drop-shadow(0 0 10px var(--neon-magenta));
}
.banner-text { position: relative; text-align: center; padding: 24px; }
.banner-kicker {
  letter-spacing: 8px;
  color: var(--neon-cyan);
  font-size: 16px;
  text-shadow: 0 0 10px var(--neon-cyan);
}
.banner-title {
  font-size: 96px;
  letter-spacing: 12px;
  font-weight: 800;
  color: var(--neon-magenta);
  text-shadow: 0 0 18px var(--neon-magenta), 0 0 38px rgba(255,43,214,0.6);
  animation: glitch 700ms infinite;
}
.banner-sub {
  letter-spacing: 4px;
  color: var(--text-dim);
  font-size: 14px;
}
@keyframes bannerIn {
  0% { transform: translateX(120%) skewX(-10deg); opacity: 0; }
  60% { transform: translateX(-2%) skewX(-2deg); opacity: 1; }
  100% { transform: translateX(0) skewX(0); opacity: 1; }
}
@keyframes bannerOut {
  0% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(-20%); opacity: 0; }
}
@keyframes glitch {
  0% { text-shadow: 0 0 18px var(--neon-magenta), 2px 0 var(--neon-cyan), -2px 0 var(--neon-yellow); }
  25% { text-shadow: 0 0 18px var(--neon-magenta), -3px 0 var(--neon-cyan), 3px 0 var(--neon-yellow); }
  50% { text-shadow: 0 0 18px var(--neon-magenta), 2px 0 var(--neon-cyan), -2px 0 var(--neon-yellow); }
  75% { text-shadow: 0 0 18px var(--neon-magenta), -1px 0 var(--neon-cyan), 1px 0 var(--neon-yellow); }
  100% { text-shadow: 0 0 18px var(--neon-magenta), 2px 0 var(--neon-cyan), -2px 0 var(--neon-yellow); }
}

/* PHASE PANE (during a cycle) */
.phase-pane {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 16px;
  height: 100%;
  border: 1px solid rgba(0,240,255,0.35);
  background: linear-gradient(180deg, rgba(0,240,255,0.04), rgba(0,0,0,0.4));
  padding: 18px;
  box-shadow: 0 0 30px rgba(0,240,255,0.15) inset;
  animation: phaseIn 500ms ease-out;
}
@keyframes phaseIn {
  0% { transform: translateY(20px); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}
.phase-header { display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: end; }
.phase-kicker { color: var(--neon-magenta); letter-spacing: 6px; font-size: 12px; }
.phase-title {
  font-size: 44px;
  font-weight: 800;
  letter-spacing: 6px;
  color: var(--neon-cyan);
  text-shadow: 0 0 12px var(--neon-cyan);
}
.phase-meta { color: var(--text-dim); font-size: 12px; letter-spacing: 2px; text-align: right; }
.phase-feed {
  overflow-y: auto;
  padding: 12px;
  background: rgba(0,0,0,0.45);
  border: 1px dashed rgba(0,240,255,0.25);
  font-size: 14px;
  line-height: 1.5;
}
.phase-feed::-webkit-scrollbar { width: 10px; }
.phase-feed::-webkit-scrollbar-thumb { background: rgba(0,240,255,0.4); }
.feed-line {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed rgba(0,240,255,0.08);
  animation: feedIn 280ms ease-out;
}
@keyframes feedIn {
  0% { transform: translateX(-20px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}
.feed-time { color: var(--text-dim); font-size: 11px; }
.feed-message { color: var(--text); white-space: pre-wrap; word-break: break-word; }
.feed-line.note .feed-message { color: var(--text-dim); }
.feed-line.bullet .feed-message::before { content: "▮ "; color: var(--neon-magenta); }
.feed-line.heavy .feed-message { color: var(--neon-cyan); text-shadow: 0 0 4px var(--neon-cyan); }
.feed-line.action-done .feed-message { color: var(--neon-green); }
.feed-line.action-failed .feed-message { color: var(--danger); }

/* TV PANE (between cycles) */
.tv-pane {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 16px;
  height: 100%;
  padding: 18px;
  border: 1px solid rgba(255,43,214,0.35);
  background: linear-gradient(180deg, rgba(255,43,214,0.04), rgba(0,0,0,0.4));
  box-shadow: 0 0 30px rgba(255,43,214,0.15) inset;
}
.tv-header { display: flex; align-items: end; justify-content: space-between; }
.tv-kicker { color: var(--neon-cyan); letter-spacing: 6px; font-size: 12px; }
.tv-title {
  font-size: 36px;
  font-weight: 800;
  letter-spacing: 8px;
  color: var(--neon-magenta);
  text-shadow: 0 0 12px var(--neon-magenta);
}
.tv-stage { position: relative; overflow: hidden; }
.tv-card {
  position: absolute;
  inset: 0;
  padding: 24px;
  border: 1px solid var(--neon-cyan);
  background:
    linear-gradient(180deg, rgba(0,240,255,0.08), rgba(0,0,0,0.7));
  box-shadow: 0 0 24px rgba(0,240,255,0.3) inset;
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 12px;
  animation: cardIn 600ms cubic-bezier(0.2, 0.8, 0.2, 1.0);
}
.tv-card.exit { animation: cardOut 400ms ease-in forwards; }
@keyframes cardIn {
  0% { clip-path: inset(50% 0 50% 0); opacity: 0; }
  60% { clip-path: inset(0 0 0 0); opacity: 1; }
  62% { clip-path: inset(0 0 0 0); opacity: 0.4; }
  100% { clip-path: inset(0 0 0 0); opacity: 1; }
}
@keyframes cardOut {
  0% { transform: translateX(0); opacity: 1; filter: blur(0); }
  100% { transform: translateX(-30%); opacity: 0; filter: blur(4px); }
}
.tv-card .tv-card-kicker { color: var(--neon-magenta); letter-spacing: 6px; font-size: 12px; }
.tv-card .tv-card-title { font-size: 36px; color: var(--neon-cyan); letter-spacing: 2px; text-shadow: 0 0 10px var(--neon-cyan); }
.tv-card .tv-card-body { color: var(--text); font-size: 16px; line-height: 1.5; overflow: hidden; }
.tv-card .tv-card-meta { color: var(--text-dim); font-size: 12px; letter-spacing: 3px; }
.tv-card.placeholder .tv-card-title { color: var(--neon-yellow); text-shadow: 0 0 10px var(--neon-yellow); }
.tv-card .tag {
  display: inline-block;
  padding: 2px 8px;
  margin-right: 8px;
  border: 1px solid var(--neon-cyan);
  color: var(--neon-cyan);
  font-size: 11px;
  letter-spacing: 2px;
}
.tv-card .tag.draft { border-color: var(--neon-yellow); color: var(--neon-yellow); }
.tv-card .tag.success { border-color: var(--neon-green); color: var(--neon-green); }
.tv-card .tag.failure { border-color: var(--danger); color: var(--danger); }
.tv-card .tag.pending { border-color: var(--neon-yellow); color: var(--neon-yellow); }
.tv-card .tag.conflict { border-color: var(--neon-magenta); color: var(--neon-magenta); }
.tv-card .accent-yellow { color: var(--neon-yellow); }

.tv-scoreboard {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.score {
  padding: 10px 12px;
  border: 1px solid rgba(0,240,255,0.35);
  background: rgba(0,0,0,0.4);
}
.score-label { color: var(--text-dim); font-size: 11px; letter-spacing: 3px; }
.score-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--neon-cyan);
  text-shadow: 0 0 8px var(--neon-cyan);
}
.score.warn .score-value { color: var(--neon-yellow); text-shadow: 0 0 8px var(--neon-yellow); }
.score.danger .score-value { color: var(--danger); text-shadow: 0 0 8px var(--danger); }
.score.ok .score-value { color: var(--neon-green); text-shadow: 0 0 8px var(--neon-green); }

/* COPILOT CALL OVERLAY (broadcast pause while we wait on the CLI) */
.copilot-overlay {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  pointer-events: none;
  animation: copilotIn 400ms ease-out;
}
.copilot-overlay.exit { animation: copilotOut 400ms ease-in forwards; }
.copilot-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at center, rgba(0,240,255,0.25), rgba(0,0,0,0.85) 70%),
    repeating-linear-gradient(0deg, rgba(0,240,255,0.06) 0 2px, transparent 2px 6px);
  backdrop-filter: blur(2px);
}
.copilot-card {
  position: relative;
  text-align: center;
  padding: 40px 64px;
  border: 2px solid var(--neon-cyan);
  background: linear-gradient(180deg, rgba(0,240,255,0.10), rgba(0,0,0,0.6));
  box-shadow: 0 0 40px rgba(0,240,255,0.5), 0 0 80px rgba(0,240,255,0.25) inset;
  min-width: 600px;
}
.copilot-kicker {
  letter-spacing: 8px;
  color: var(--neon-magenta);
  font-size: 16px;
  text-shadow: 0 0 8px var(--neon-magenta);
  margin-bottom: 16px;
  animation: copilotPulse 1.2s ease-in-out infinite;
}
.copilot-title {
  font-size: 64px;
  font-weight: 800;
  letter-spacing: 10px;
  line-height: 1.05;
  color: var(--neon-cyan);
  text-shadow: 0 0 18px var(--neon-cyan), 0 0 36px rgba(0,240,255,0.5);
  animation: glitch 900ms infinite;
}
.copilot-sub {
  margin-top: 18px;
  color: var(--text);
  font-size: 15px;
  letter-spacing: 3px;
  opacity: 0.9;
}
.copilot-bars {
  margin-top: 22px;
  display: flex;
  gap: 6px;
  justify-content: center;
}
.copilot-bars span {
  width: 8px;
  height: 24px;
  background: var(--neon-cyan);
  box-shadow: 0 0 6px var(--neon-cyan);
  animation: copilotBar 900ms ease-in-out infinite;
}
.copilot-bars span:nth-child(2) { animation-delay: 80ms; background: var(--neon-magenta); box-shadow: 0 0 6px var(--neon-magenta); }
.copilot-bars span:nth-child(3) { animation-delay: 160ms; }
.copilot-bars span:nth-child(4) { animation-delay: 240ms; background: var(--neon-magenta); box-shadow: 0 0 6px var(--neon-magenta); }
.copilot-bars span:nth-child(5) { animation-delay: 320ms; }
.copilot-bars span:nth-child(6) { animation-delay: 400ms; background: var(--neon-magenta); box-shadow: 0 0 6px var(--neon-magenta); }
.copilot-bars span:nth-child(7) { animation-delay: 480ms; }
.copilot-bars span:nth-child(8) { animation-delay: 560ms; background: var(--neon-magenta); box-shadow: 0 0 6px var(--neon-magenta); }
.copilot-bars span:nth-child(9) { animation-delay: 640ms; }
.copilot-bars span:nth-child(10) { animation-delay: 720ms; background: var(--neon-magenta); box-shadow: 0 0 6px var(--neon-magenta); }
.copilot-elapsed {
  margin-top: 18px;
  color: var(--neon-yellow);
  letter-spacing: 6px;
  font-size: 22px;
  text-shadow: 0 0 8px var(--neon-yellow);
}
@keyframes copilotIn {
  0% { opacity: 0; transform: scale(0.98); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes copilotOut {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes copilotPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes copilotBar {
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1.6); }
}

/* LOWER THIRD TICKER */
.lower-third {
  position: relative;
  z-index: 5;
  border-top: 1px solid rgba(0,240,255,0.35);
  background: linear-gradient(0deg, rgba(0,240,255,0.08), transparent);
  overflow: hidden;
}
.ticker {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
}
.ticker-track {
  display: inline-block;
  padding-left: 100vw;
  color: var(--neon-cyan);
  letter-spacing: 3px;
  font-size: 14px;
  animation: ticker 60s linear infinite;
  text-shadow: 0 0 4px var(--neon-cyan);
}
@keyframes ticker {
  0% { transform: translateX(0); }
  100% { transform: translateX(-100%); }
}
`;
}

function renderAppJs(): string {
  // Single-file front-end. Kept dependency-free (no bundler) so the
  // build step (`tsc`) doesn't need to know about asset pipelines.
  return `(() => {
  "use strict";

  const el = (id) => document.getElementById(id);
  const fmtDuration = (ms) => {
    if (ms <= 0) return "LIVE";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    const h = Math.floor(m / 60);
    const min = m % 60;
    if (h > 0) return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return String(min).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  };

  const state = {
    nextCycleAt: null,
    inCycle: false,
    repo: null,
    repositoryUrl: null,
    snapshot: null,
    currentPhase: null,
    rateLimitedUntil: null,
    iteration: 0,
  };

  function applyServerState(s) {
    Object.assign(state, {
      nextCycleAt: s.nextCycleAt,
      inCycle: s.inCycle,
      repo: s.repo,
      repositoryUrl: s.repositoryUrl,
      snapshot: s.snapshot,
      currentPhase: s.currentPhase,
      rateLimitedUntil: s.rateLimitedUntil,
      iteration: s.currentIteration || 0,
    });
    renderRepo();
    renderMode();
  }

  function renderRepo() {
    if (state.repo) {
      el("repo-info").textContent = "▮ " + state.repo;
    }
  }

  function renderMode() {
    if (state.inCycle) {
      el("phase-pane").hidden = false;
      el("tv-pane").hidden = true;
    } else {
      el("phase-pane").hidden = true;
      el("tv-pane").hidden = false;
    }
  }

  // ── Countdown ────────────────────────────────────────────────────────────
  function tickCountdown() {
    const node = el("countdown");
    if (state.inCycle) {
      node.textContent = "LIVE";
      node.classList.add("live");
      return;
    }
    node.classList.remove("live");
    if (!state.nextCycleAt) {
      node.textContent = "--:--";
      return;
    }
    const remaining = new Date(state.nextCycleAt).getTime() - Date.now();
    node.textContent = fmtDuration(remaining);
  }
  setInterval(tickCountdown, 250);

  // ── Phase feed ───────────────────────────────────────────────────────────
  const PHASE_TREATMENTS = {
    "Workflow approvals": { kicker: "PHASE 01", display: "CLEARING THE GATES" },
    "Repository snapshot": { kicker: "PHASE 02", display: "CONNECTING TO THE MAINFRAME" },
    "Reconciliation": { kicker: "PHASE 03", display: "RECONCILING THE FIELD" },
    "Copilot rate-limit check": { kicker: "PHASE 04", display: "QUOTA SWEEP" },
    "Blocked issues": { kicker: "PHASE 05", display: "BLOCKER TRIAGE" },
    "Plan": { kicker: "PHASE 06", display: "TAKING ACTIONS" },
  };

  function setPhase(name) {
    state.currentPhase = name;
    const titleNode = el("phase-title");
    const metaNode = el("phase-meta");
    const treatment = PHASE_TREATMENTS[name] || { kicker: "PHASE", display: name.toUpperCase() };
    titleNode.textContent = treatment.display;
    metaNode.textContent = treatment.kicker + " // ITERATION " + state.iteration;
    el("phase-pane").hidden = false;
    el("tv-pane").hidden = true;
  }

  function appendFeedLine(evt) {
    const feed = el("phase-feed");
    const line = document.createElement("div");
    line.className = "feed-line " + (evt.level || "info");
    if (evt._extraClass) line.classList.add(evt._extraClass);
    const time = document.createElement("span");
    time.className = "feed-time";
    time.textContent = (evt.timestamp || new Date().toISOString()).slice(11, 19);
    const msg = document.createElement("span");
    msg.className = "feed-message";
    msg.textContent = "  ".repeat(evt.indent || 0) + (evt.message || "");
    line.appendChild(time);
    line.appendChild(msg);
    feed.appendChild(line);
    // Cap feed length to keep DOM light during long runs.
    while (feed.childNodes.length > 400) feed.removeChild(feed.firstChild);
    feed.scrollTop = feed.scrollHeight;
  }

  function clearFeed() {
    el("phase-feed").innerHTML = "";
  }

  // ── Cycle banner ─────────────────────────────────────────────────────────
  function showBanner(iteration) {
    const banner = el("banner");
    el("banner-title").textContent = "CYCLE " + String(iteration).padStart(4, "0");
    el("banner-sub").textContent = state.repo ? "TARGET: " + state.repo : "";
    banner.hidden = false;
    banner.classList.remove("exit");
    setTimeout(() => {
      banner.classList.add("exit");
      setTimeout(() => { banner.hidden = true; }, 600);
    }, 2400);
  }

  // ── TV broadcast carousel (between cycles) ───────────────────────────────
  let tvIndex = 0;
  let tvTimer = null;
  function startTvLoop() {
    if (tvTimer) return;
    renderTvCard();
    tvTimer = setInterval(renderTvCard, 5000);
  }
  function stopTvLoop() {
    if (tvTimer) { clearInterval(tvTimer); tvTimer = null; }
  }

  // Each segment's "body" is an array of structured parts that
  // renderTvCard renders via DOM APIs / textContent rather than innerHTML,
  // so that repo-supplied text (PR titles, branch names, issue titles,
  // assignees, etc.) can never inject HTML or script into the dashboard.
  // Supported part kinds: {text:string} for plain runs (line breaks come
  // from explicit {br:true} parts), {tag:string, cls?:string} for the
  // small whitelist of styled tag chips, and {accent:string} for
  // neon-yellow inline accents (branch names, timestamps).
  function tagFor(status) {
    if (status === "success") return { tag: "CI ✓", cls: "success" };
    if (status === "failure") return { tag: "CI ✗", cls: "failure" };
    if (status === "pending") return { tag: "CI …", cls: "pending" };
    return { tag: "CI —" };
  }

  function buildTvSegments() {
    const segs = [];
    const snap = state.snapshot;
    if (snap) {
      for (const pr of snap.pullRequests) {
        const body = [];
        body.push({ text: pr.title });
        body.push({ br: true }, { br: true });
        body.push(pr.draft ? { tag: "DRAFT", cls: "draft" } : { tag: "READY", cls: "success" });
        body.push({ text: " " });
        body.push(tagFor(pr.checksStatus));
        if (pr.hasMergeConflicts) {
          body.push({ text: " " }, { tag: "CONFLICTS", cls: "conflict" });
        }
        body.push({ br: true }, { br: true });
        body.push({ text: "branch: " });
        body.push({ accent: pr.headRefName });
        body.push({ text: " · " + pr.changedFiles + " file(s) changed" });
        if (pr.linkedIssueNumbers && pr.linkedIssueNumbers.length) {
          body.push({ text: " ⟶ closes " + pr.linkedIssueNumbers.map((n) => "#" + n).join(", ") });
        }
        segs.push({
          kicker: "NOW PLAYING // PULL REQUEST",
          title: "PR #" + pr.number,
          body: body,
          meta: pr.url,
        });
      }
      for (const issue of snap.issues.slice(0, 12)) {
        const blockers = snap.blockedIssueNumbers && snap.blockedIssueNumbers[issue.number];
        const body = [];
        body.push({ text: issue.title });
        if (issue.type) {
          body.push({ br: true }, { br: true });
          body.push({ tag: String(issue.type).toUpperCase() });
        }
        if (issue.assignees && issue.assignees.length) {
          body.push({ br: true }, { br: true });
          body.push({ text: "assignees: " + issue.assignees.join(", ") });
        }
        if (blockers && blockers.length) {
          body.push({ br: true }, { br: true });
          body.push({ tag: "BLOCKED BY", cls: "conflict" });
          body.push({ text: " " + blockers.map((n) => "#" + n).join(", ") });
        }
        segs.push({
          kicker: "INCOMING // OPEN ISSUE",
          title: "#" + issue.number,
          body: body,
          meta: issue.url,
        });
      }
      for (const sess of snap.agentSessions) {
        const target = sess.pullRequestNumber !== undefined
          ? "PR #" + sess.pullRequestNumber
          : sess.issueNumber !== undefined ? "issue #" + sess.issueNumber : "(unlinked)";
        const body = [];
        body.push({ text: "Target: " + target });
        body.push({ br: true }, { br: true });
        body.push({ tag: String(sess.status).toUpperCase() });
        body.push({ br: true }, { br: true });
        body.push({ text: "session " + String(sess.id).slice(0, 8) + "…" });
        segs.push({
          kicker: "AGENT FIELD // SESSION",
          title: String(sess.phase).toUpperCase(),
          body: body,
          meta: "AGENT SESSION",
        });
      }
    }
    if (state.rateLimitedUntil) {
      const body = [
        { text: "Copilot quota engaged. Resuming at " },
        { accent: new Date(state.rateLimitedUntil).toISOString() },
      ];
      segs.unshift({
        kicker: "⚠ TRANSMISSION DELAY",
        title: "RATE LIMIT",
        body: body,
        meta: "STAND BY",
      });
    }
    if (segs.length === 0) {
      segs.push({
        kicker: "STAND BY",
        title: "AWAITING SIGNAL",
        body: [{ text: "Synchronising with the mainframe. Next cycle on the countdown." }],
        meta: state.repositoryUrl || "",
      });
    }
    return segs;
  }

  // Append a single structured body part to the target node using DOM APIs
  // so user-controlled text never reaches innerHTML.
  function appendBodyPart(target, part) {
    if (!part) return;
    if (part.br) { target.appendChild(document.createElement("br")); return; }
    if (part.tag !== undefined) {
      const span = document.createElement("span");
      span.className = "tag" + (part.cls ? " " + part.cls : "");
      span.textContent = part.tag;
      target.appendChild(span);
      return;
    }
    if (part.accent !== undefined) {
      const span = document.createElement("span");
      span.className = "accent-yellow";
      span.textContent = part.accent;
      target.appendChild(span);
      return;
    }
    if (part.text !== undefined) {
      target.appendChild(document.createTextNode(String(part.text)));
    }
  }

  function renderTvCard() {
    const stage = el("tv-stage");
    const segs = buildTvSegments();
    const seg = segs[tvIndex % segs.length];
    tvIndex++;
    const card = document.createElement("div");
    card.className = "tv-card";

    const kicker = document.createElement("div");
    kicker.className = "tv-card-kicker";
    kicker.textContent = seg.kicker;
    card.appendChild(kicker);

    const title = document.createElement("div");
    title.className = "tv-card-title";
    title.textContent = seg.title;
    card.appendChild(title);

    const bodyNode = document.createElement("div");
    bodyNode.className = "tv-card-body";
    for (const part of seg.body) appendBodyPart(bodyNode, part);
    card.appendChild(bodyNode);

    const meta = document.createElement("div");
    meta.className = "tv-card-meta";
    meta.textContent = seg.meta || "";
    card.appendChild(meta);

    // Animate the old card out, the new one in.
    const old = stage.querySelector(".tv-card");
    if (old) {
      old.classList.add("exit");
      setTimeout(() => old.remove(), 400);
    }
    stage.appendChild(card);
    renderScoreboard();
  }

  function renderScoreboard() {
    const sb = el("tv-scoreboard");
    sb.textContent = "";
    const snap = state.snapshot;
    if (!snap) return;
    const prs = snap.pullRequests;
    const drafts = prs.filter((p) => p.draft).length;
    const ready = prs.length - drafts;
    const ciFail = prs.filter((p) => p.checksStatus === "failure").length;
    const conflicts = prs.filter((p) => p.hasMergeConflicts).length;
    const active = snap.agentSessions.filter((s) => s.status === "queued" || s.status === "in_progress").length;
    sb.appendChild(score("OPEN ISSUES", snap.issues.length));
    sb.appendChild(score("OPEN PRs", prs.length + " (" + drafts + " draft, " + ready + " ready)"));
    sb.appendChild(score("ACTIVE AGENTS", active, active > 0 ? "ok" : ""));
    sb.appendChild(score("CI FAILURES", ciFail + (conflicts ? " · " + conflicts + " conflicts" : ""), ciFail || conflicts ? "danger" : "ok"));
  }
  function score(label, value, cls) {
    const root = document.createElement("div");
    root.className = "score" + (cls ? " " + cls : "");
    const labelNode = document.createElement("div");
    labelNode.className = "score-label";
    labelNode.textContent = label;
    const valueNode = document.createElement("div");
    valueNode.className = "score-value";
    valueNode.textContent = String(value);
    root.appendChild(labelNode);
    root.appendChild(valueNode);
    return root;
  }

  // ── Ticker ───────────────────────────────────────────────────────────────
  function updateTicker() {
    const snap = state.snapshot;
    const parts = [];
    if (state.repo) parts.push("▮ " + state.repo);
    if (snap) {
      parts.push("OPEN ISSUES: " + snap.issues.length);
      parts.push("OPEN PRs: " + snap.pullRequests.length);
      for (const pr of snap.pullRequests.slice(0, 8)) {
        parts.push("PR #" + pr.number + " " + pr.title);
      }
      for (const issue of snap.issues.slice(0, 8)) {
        parts.push("ISSUE #" + issue.number + " " + issue.title);
      }
    }
    if (state.rateLimitedUntil) parts.push("⚠ RATE LIMIT IN EFFECT");
    if (parts.length === 0) parts.push("NO SIGNAL");
    el("ticker-track").textContent = parts.join("   ▮▮   ") + "   ▮▮   ";
  }

  // ── Copilot CLI call overlay ────────────────────────────────────────────
  let copilotElapsedTimer = null;
  let copilotStartedAt = 0;
  function showCopilotOverlay(d) {
    const overlay = el("copilot-overlay");
    el("copilot-kicker").textContent = "📡 OUTBOUND TRANSMISSION // " + (d.kind || "copilot-cli").toUpperCase();
    el("copilot-sub").textContent = (d.description || "") + (d.pullRequestNumber ? "  ·  PR #" + d.pullRequestNumber : "");
    el("copilot-elapsed").textContent = "00:00";
    overlay.hidden = false;
    overlay.classList.remove("exit");
    copilotStartedAt = Date.now();
    if (copilotElapsedTimer) clearInterval(copilotElapsedTimer);
    copilotElapsedTimer = setInterval(() => {
      const s = Math.floor((Date.now() - copilotStartedAt) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      el("copilot-elapsed").textContent = mm + ":" + ss;
    }, 1000);
  }
  function hideCopilotOverlay(d) {
    if (copilotElapsedTimer) { clearInterval(copilotElapsedTimer); copilotElapsedTimer = null; }
    const overlay = el("copilot-overlay");
    if (d && d.durationMs !== undefined) {
      const s = Math.floor(d.durationMs / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      el("copilot-elapsed").textContent = (d.ok === false ? "✗ " : "✓ ") + mm + ":" + ss;
    }
    overlay.classList.add("exit");
    setTimeout(() => { overlay.hidden = true; overlay.classList.remove("exit"); }, 400);
  }

  // ── SSE wiring ───────────────────────────────────────────────────────────
  function connect() {
    const source = new EventSource("/events");
    source.addEventListener("state", (e) => {
      try { applyServerState(JSON.parse(e.data)); renderMode(); } catch (err) {}
    });
    source.addEventListener("startup", (e) => {
      try {
        const d = JSON.parse(e.data);
        state.repo = d.repo;
        state.repositoryUrl = d.repositoryUrl;
        renderRepo();
      } catch (err) {}
    });
    source.addEventListener("countdown", (e) => {
      try { state.nextCycleAt = JSON.parse(e.data).nextCycleAt; } catch (err) {}
    });
    source.addEventListener("cycle-start", (e) => {
      try {
        const d = JSON.parse(e.data);
        state.inCycle = true;
        state.iteration = d.iteration;
        clearFeed();
        showBanner(d.iteration);
        stopTvLoop();
        renderMode();
      } catch (err) {}
    });
    source.addEventListener("cycle-end", (e) => {
      try {
        const d = JSON.parse(e.data);
        state.inCycle = false;
        state.nextCycleAt = d.nextCycleAt;
        renderMode();
        startTvLoop();
      } catch (err) {}
    });
    source.addEventListener("phase", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === "start") setPhase(d.phase);
      } catch (err) {}
    });
    source.addEventListener("log", (e) => {
      try { appendFeedLine(JSON.parse(e.data)); } catch (err) {}
    });
    source.addEventListener("snapshot", (e) => {
      try {
        state.snapshot = JSON.parse(e.data).summary;
        updateTicker();
        renderScoreboard();
      } catch (err) {}
    });
    source.addEventListener("action", (e) => {
      try {
        const d = JSON.parse(e.data);
        const cls = d.status === "done" ? "action-done" : d.status === "failed" ? "action-failed" : "";
        appendFeedLine({
          level: "note",
          indent: 2,
          message: "[" + d.index + "/" + d.total + "] " + (d.status === "start" ? "→ " : d.status === "done" ? "✓ " : "✗ ") + d.description + (d.error ? " — " + d.error : ""),
          timestamp: d.timestamp,
          _extraClass: cls,
        });
      } catch (err) {}
    });
    source.addEventListener("rate-limit", (e) => {
      try { state.rateLimitedUntil = JSON.parse(e.data).resetAt; updateTicker(); } catch (err) {}
    });
    source.addEventListener("copilot-call", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === "start") showCopilotOverlay(d);
        else hideCopilotOverlay(d);
      } catch (err) {}
    });
    source.onerror = () => {
      // EventSource auto-reconnects; we just surface a tiny status hint.
    };
  }

  // Bootstrap. Use /state as the canonical initial snapshot so we render
  // immediately even before the first SSE frame arrives.
  fetch("/state").then((r) => r.json()).then((data) => {
    applyServerState(data.state);
    renderMode();
    if (!state.inCycle) startTvLoop();
    updateTicker();
  }).catch(() => {}).finally(connect);
})();
`;
}
