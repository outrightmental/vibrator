import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import open from "open";
import { globalEventEmitter, EventEmitter, type DashboardEvent } from "./event-emitter.js";

/**
 * Per-client cap on buffered (un-flushed) WebSocket data. A backgrounded or
 * slow browser cannot drain the high-frequency event stream as fast as it is
 * produced; without this guard `ws` queues every message in memory, which can
 * exhaust the process. Once a client is this far behind, droppable live events
 * are skipped for it until it catches up.
 */
const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;

interface DashboardServerConfig {
  port: number;
  host?: string;
  owner: string;
  repo: string;
  dashboardTitle?: string;
  /** Per-project event emitter. When provided, engine events are scoped to this emitter
   *  and cylinder-cancel signals are emitted to it (not globalEventEmitter). App-level
   *  events (shutdown-requested, app-shutdown) are still received via globalEventEmitter. */
  eventEmitter?: EventEmitter;
}

const ROOT_DIR = process.cwd();

let APP_VERSION = "unknown";
try {
  const pkgText = fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf-8");
  APP_VERSION = (JSON.parse(pkgText) as { version: string }).version;
} catch { /* ignore */ }
const STATIC_INDEX = path.join(ROOT_DIR, "src", "dashboard", "index.html");
const STATIC_BUNDLE_JS = path.join(ROOT_DIR, "dist", "dashboard", "bundle.js");
const STATIC_BUNDLE_CSS = path.join(ROOT_DIR, "dist", "dashboard", "bundle.css");

async function serveStatic(res: http.ServerResponse, filePath: string, mimeType: string): Promise<void> {
  try {
    const data = await fs.promises.readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeType });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

export class DashboardServer {
  private port: number;
  private host: string;
  private owner: string;
  private repo: string;
  private dashboardTitle: string;
  private server: http.Server;
  private wss: WebSocketServer;
  private maxConcurrency: number = 3;
  private cachedEvents: Map<string, DashboardEvent> = new Map();
  private cssWatcher: ReturnType<typeof fs.watch> | null = null;
  private cssReloadDebounce: ReturnType<typeof setTimeout> | null = null;
  private projectEmitter: EventEmitter;
  private _unsubscribers: (() => void)[] = [];

  constructor(config: DashboardServerConfig) {
    this.port = config.port;
    this.host = config.host ?? "localhost";
    this.owner = config.owner;
    this.repo = config.repo;
    this.dashboardTitle = config.dashboardTitle ?? config.repo;
    this.projectEmitter = config.eventEmitter ?? globalEventEmitter;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: Error) => {
        console.error("[Dashboard] Unhandled request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal_server_error" }));
        }
      });
    });

    // Gate WebSocket upgrades to /api/ws only
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/api/ws") {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws) => this.handleWebSocketConnection(ws));
    this.wss.on("error", (error: Error) => {
      console.error("[Dashboard] WebSocket server error:", error);
    });

    this._unsubscribers.push(this.projectEmitter.subscribe((event) => {
      this.broadcastEvent(event);
    }));
    // When using a per-project emitter, also listen on the global emitter for
    // app-level events (shutdown-requested, app-shutdown) so connected browser
    // clients receive graceful-shutdown notifications.
    if (config.eventEmitter) {
      this._unsubscribers.push(globalEventEmitter.subscribe((event) => {
        if (event.type === "shutdown-requested" || event.type === "app-shutdown") {
          this.broadcastEvent(event);
        }
      }));
    }
  }

  private unsubscribeFromEvents(): void {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      try {
        let html = await fs.promises.readFile(STATIC_INDEX, "utf-8");
        html = html.replace(/(<title>)Vibrator([:< ])/, (_, p1: string, p2: string) => `${p1}${this.dashboardTitle}${p2}`);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
      return;
    }

    if (pathname === "/assets/bundle.js") {
      await serveStatic(res, STATIC_BUNDLE_JS, "application/javascript");
      return;
    }

    if (pathname === "/assets/bundle.css") {
      await serveStatic(res, STATIC_BUNDLE_CSS, "text/css");
      return;
    }

    if (pathname === "/api/state") {
      jsonResponse(res, 200, {
        version: 1,
        owner: this.owner,
        repo: this.repo,
        dashboardTitle: this.dashboardTitle,
        maxConcurrency: this.maxConcurrency,
        cachedEvents: Array.from(this.cachedEvents.values()),
      });
      return;
    }

    if (pathname === "/api/health") {
      jsonResponse(res, 200, { ok: true, version: APP_VERSION, owner: this.owner, repo: this.repo });
      return;
    }

    jsonResponse(res, 404, { error: "not_found" });
  }

  private handleWebSocketConnection(ws: WebSocket): void {
    ws.on("error", (error: Error) => {
      console.error("[Dashboard] WebSocket error:", error);
    });

    ws.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as { type: string; engineIndex?: number };
        if (message.type === "cylinder-cancel-request" && typeof message.engineIndex === "number") {
          this.projectEmitter.emit("cylinder-cancel", { engineIndex: message.engineIndex });
        }
      } catch {
        // Ignore malformed messages from clients
      }
    });

  }

  private updateStateCache(event: DashboardEvent): void {
    const { type, data } = event;
    if (type === "lifecycle-update" || type === "snapshot-update") {
      this.cachedEvents.set(type, event);
    } else if (type === "action-start" || type === "action-complete" || type === "action-error") {
      const cylinderIdx = ((data["actionIndex"] as number) || 1) - 1;
      this.cachedEvents.set(`cylinder-${cylinderIdx}`, event);
    } else if (type === "iteration-start" || type === "engine-idle") {
      const engineIndex = (data["engineIndex"] as number) ?? 0;
      this.cachedEvents.set(`cylinder-${engineIndex}`, event);
      if (type === "iteration-start") {
        const n = data["maxConcurrency"] as number | undefined;
        if (typeof n === "number") this.maxConcurrency = n;
      }
    } else if (type === "engine-shutdown") {
      const engineIndex = (data["engineIndex"] as number) ?? 0;
      this.cachedEvents.set(`cylinder-${engineIndex}`, event);
    } else if (type === "github-rate-limit") {
      this.cachedEvents.set(type, event);
    } else if (type === "github-rate-limit-cleared") {
      this.cachedEvents.delete("github-rate-limit");
    } else if (type === "shutdown-requested" || type === "app-shutdown") {
      this.cachedEvents.set(type, event);
    }
  }

  private broadcastEvent(event: DashboardEvent): void {
    this.updateStateCache(event);
    const message = JSON.stringify(event);
    // High-frequency, ephemeral events (log lines) are skipped for any client
    // that has fallen behind, so a slow or backgrounded browser cannot make ws
    // buffer them without bound. Infrequent state events are always delivered
    // and are replayed from the cache on reconnect, so the dashboard still
    // converges to the correct state.
    const droppableUnderBackpressure =
      event.type === "log-message";
    for (const client of this.wss.clients) {
      if (client.readyState !== 1) continue; // not OPEN
      if (droppableUnderBackpressure && client.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) {
        continue;
      }
      client.send(message);
    }
  }

  async initialize(): Promise<void> {
    // no-op: static assets served from src/dashboard/ and dist/dashboard/
  }

  private async generateHTML(): Promise<string> {
    const css = await this.generateCSS();
    const js = this.generateJS(this.owner, this.repo, this.dashboardTitle);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vibrator: AI SDLC Dashboard</title>
  <style>${css}</style>
</head>
<body>
  <div id="app" class="app-container"></div>
  <script>${js}</script>
</body>
</html>`;
  }

  private async generateCSS(): Promise<string> {
    return `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'IBM Plex Mono', monospace;
  background: #0a0e27;
  color: #00ff88;
  overflow: hidden;
  height: 100vh;
}

.app-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #0a0e27 0%, #1a0a3e 100%);
  position: relative;
  overflow: hidden;
}

.app-container::before {
  content: '';
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: repeating-linear-gradient(
    0deg,
    rgba(0, 255, 136, 0.025) 0px,
    rgba(0, 255, 136, 0.025) 1px,
    transparent 1px,
    transparent 2px
  );
  pointer-events: none;
  z-index: -1;
  animation: scanlines 8s linear infinite;
}

@keyframes scanlines {
  0% { transform: translateY(0); }
  100% { transform: translateY(10px); }
}

/* ── Header ── */
.header {
  padding: 14px 24px;
  border-bottom: 2px solid #00ff88;
  box-shadow: 0 0 20px rgba(0, 255, 136, 0.3);
  background: rgba(10, 14, 39, 0.95);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  z-index: 10;
  flex-shrink: 0;
}

.header-title {
  display: flex;
  align-items: center;
  font-size: 24px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 3px;
  color: #00ff88;
  text-shadow: 0 0 10px rgba(0, 255, 136, 0.8);
}

.header-title span {
  font-size: 0.5em;
  font-weight: 300;
  color: magenta;
  margin-left: 8px;
}

.iteration-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

.iteration-label {
  font-size: 10px;
  color: #ff00ff;
  text-transform: uppercase;
  letter-spacing: 2px;
}

.iteration-number {
  font-size: 20px;
  font-weight: 700;
  color: #ff00ff;
  text-shadow: 0 0 10px rgba(255, 0, 255, 0.8);
  font-variant-numeric: tabular-nums;
}

.countdown {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 3px;
}

.countdown-label {
  font-size: 10px;
  color: #0088ff;
  text-transform: uppercase;
  letter-spacing: 2px;
}

.countdown-timer {
  margin-top: -6px !important;
  margin-left: 6px !important;
  font-size: 22px;
  font-weight: 700;
  color: #00ff88;
  text-shadow: 0 0 15px rgba(0, 255, 136, 1);
  font-variant-numeric: tabular-nums;
}

.countdown.state-waiting .countdown-label {
  color: #ffcc00;
}

.countdown.state-waiting .countdown-timer {
  color: #ffcc00;
  text-shadow: 0 0 15px rgba(255, 204, 0, 0.8);
}

.countdown.state-working .countdown-label {
  color: #00ff88;
  font-size: 12px;
}

.countdown.state-working .countdown-timer {
  font-size: 32px;
  color: #00ff88;
  text-shadow: 0 0 20px rgba(0, 255, 136, 1), 0 0 40px rgba(0, 255, 136, 0.5);
}


.main-content {
  flex: 1;
  display: flex;
  gap: 14px;
  padding: 14px 20px;
  overflow: hidden;
  min-height: 0;
}

.panel {
  display: flex;
  flex-direction: column;
  background: rgba(20, 10, 50, 0.6);
  border: 2px solid rgba(0, 255, 136, 0.3);
  border-radius: 4px;
  overflow: hidden;
  min-height: 0;
}

/* Panel A: N-Cylinder Engine — anchors the left */
.panel-a {
  width: 280px;
  flex-shrink: 0;
  border-color: rgba(0, 255, 136, 0.5);
  box-shadow: 0 0 24px rgba(0, 255, 136, 0.08), inset 0 0 16px rgba(0, 255, 136, 0.03);
}

/* Panel B: Issue→PR Lifecycle */
.panel-b {
  flex: 2;
  min-width: 0;
}

/* Panel C: Event Stream */
.panel-c {
  flex: 1;
  min-width: 180px;
  background: rgba(20, 10, 50, 0.6);
  border: 2px solid #00ff88;
  border-radius: 4px;
  box-shadow: 0 0 20px rgba(0, 255, 136, 0.2), inset 0 0 20px rgba(0, 255, 136, 0.05);
}

.panel-header {
  padding: 9px 14px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: #00ff88;
  border-bottom: 1px solid rgba(0, 255, 136, 0.25);
  text-shadow: 0 0 8px rgba(0, 255, 136, 0.5);
  flex-shrink: 0;
  background: rgba(0, 255, 136, 0.03);
}

.panel-c .panel-body {
  padding: 10px;
}

/* Refine 'AI SDLC BROADCAST' in the main header */
.header-title {
  display: flex;
  align-items: center;
}

/* Make 'AI SDLC BROADCAST' half-size, magenta, lightweight, and vertically centered */
.header-title span {
  font-size: 0.5em;
  font-weight: 300;
  color: #ff00ff;
  margin-left: 10px;
  align-self: center;
  letter-spacing: 2px;
  vertical-align: middle;
}

/* Adjust the subtitle in the center panel header */
.panel-b .panel-header span#lifecycle-subtitle {
  font-size: 10px;
  color: rgba(0, 255, 136, 0.6);
  margin-left: 8px;
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
}

.panel-body::-webkit-scrollbar {
  width: 8px;
}

.panel-body::-webkit-scrollbar-track {
  background: rgba(0, 255, 136, 0.1);
}

.panel-body::-webkit-scrollbar-thumb {
  background: rgba(0, 255, 136, 0.5);
  border-radius: 4px;
}

.lifecycle-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}

.lifecycle-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: rgba(0, 255, 136, 0.7);
}

.lifecycle-subtitle {
  font-size: 10px;
  color: rgba(0, 255, 136, 0.35);
  letter-spacing: 1px;
}

.lifecycle-content {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 52px;
  overflow-x: hidden;
}

.lifecycle-empty {
  font-size: 11px;
  color: rgba(0, 255, 136, 0.4);
  letter-spacing: 1px;
  align-self: center;
  padding: 10px 0;
}

/* Two-halved pill */
.lifecycle-pill {
  display: flex;
  height: 52px;
  width: 100%;
  min-width: 380px;
  animation: pillAppear 0.4s cubic-bezier(0.34, 1.3, 0.64, 1);
}

@keyframes pillAppear {
  from { opacity: 0; transform: scaleX(0.85); }
  to   { opacity: 1; transform: scaleX(1); }
}

.pill-issue-half {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 16px;
  border: 2px solid var(--pill-color);
  border-right: none;
  border-radius: 999px 0 0 999px;
  background: rgba(var(--pill-rgb), 0.1);
  min-width: 0;
  overflow: hidden;
}

/* Orphan PR — left half is empty; the pill still reads as one whole pill. */
.pill-issue-half.empty {
  background: rgba(var(--pill-rgb), 0.04);
}

.pill-pr-half {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 16px;
  border-radius: 0 999px 999px 0;
  transition: background 0.5s ease, opacity 0.5s ease;
  min-width: 0;
  overflow: hidden;
  position: relative;
}

.pill-pr-half.absent {
  border: 2px dashed rgba(128, 128, 128, 0.2);
  opacity: 0.35;
}

.pill-pr-half.planning {
  border: 2px dashed var(--pill-color);
  background: transparent;
  animation: planningPulse 1.8s ease-in-out infinite;
}

@keyframes planningPulse {
  0%, 100% { opacity: 0.5; }
  50%       { opacity: 1; }
}

.pill-pr-half.active {
  border: 2px solid var(--pill-color);
  border-left: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(var(--pill-rgb), 0.14);
}

.pill-pr-half.review {
  border: 2px solid var(--pill-color);
  border-left: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(var(--pill-rgb), 0.25);
  box-shadow: 0 0 10px rgba(var(--pill-rgb), 0.35);
}

.pill-pr-half.completed {
  border: 2px solid var(--pill-color);
  border-left: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(var(--pill-rgb), 0.38);
  box-shadow: inset 0 0 14px rgba(var(--pill-rgb), 0.2);
}

.pill-label {
  font-size: 8px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--pill-color);
  opacity: 0.6;
  white-space: nowrap;
}

.pill-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pill-number {
  font-size: 11px;
  font-weight: 700;
  color: var(--pill-color);
  white-space: nowrap;
}

.pill-title {
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(255, 255, 255, 0.75);
}

.pill-badge {
  font-size: 8px;
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid var(--pill-color);
  color: var(--pill-color);
  opacity: 0.7;
  white-space: nowrap;
  flex-shrink: 0;
}

.pill-badge-blocked {
  border-color: rgba(255, 100, 80, 0.7);
  color: rgba(255, 130, 110, 1);
}

.pill-badge-inactive {
  border-color: rgba(160, 160, 175, 0.55);
  color: rgba(185, 185, 200, 0.85);
}

.pill-pr-half.absent.blocked {
  border: 2px dashed rgba(255, 100, 80, 0.35);
  opacity: 0.75;
}

.pill-pr-half.inactive {
  border: 2px dashed rgba(120, 120, 135, 0.4);
  opacity: 0.55;
}

/* A "manual"-labelled PR: parked, never worked on automatically. */
.pill-pr-half.disabled {
  border: 2px dashed rgba(150, 150, 160, 0.4);
  background: rgba(150, 150, 160, 0.06);
  box-shadow: none;
  opacity: 0.45;
  filter: grayscale(1);
  animation: none;
}

/* ── Panel A: Cylinder rows ── */
.cylinder-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  min-height: 80px;
  overflow: hidden;
  border-bottom: 1px solid rgba(0, 255, 136, 0.08);
  transition: background 0.3s ease, border-color 0.3s ease;
}

.cylinder-row.active {
  background: rgba(var(--cyl-color-rgb, 0, 255, 136), 0.06);
  border-left: 3px solid var(--cyl-color, #00ff88);
  padding-left: 9px;
  box-shadow: inset 0 0 20px rgba(0,0,0,0.2);
}

.cylinder-row.done {
  opacity: 0.65;
}

.cylinder-row.error {
  border-left: 3px solid #ff0055;
  padding-left: 9px;
}

.cylinder-row.shutdown {
  opacity: 0.5;
  border-left: 3px solid #ff6600;
  padding-left: 9px;
}

.cylinder-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--cyl-color, #00ff88);
  box-shadow: 0 0 6px var(--cyl-color, #00ff88);
  flex-shrink: 0;
  opacity: 0.45;
  margin-top: 2px;
  transition: opacity 0.3s ease;
}

.cylinder-row.active .cylinder-dot {
  opacity: 1;
}

.cylinder-dot.pulsing {
  animation: cylPulse 1.2s ease-in-out infinite;
}

@keyframes cylPulse {
  0%, 100% { box-shadow: 0 0 6px var(--cyl-color, #00ff88); opacity: 1; }
  50%       { box-shadow: 0 0 18px var(--cyl-color, #00ff88), 0 0 30px var(--cyl-color, #00ff88); opacity: 0.8; }
}

.cylinder-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(var(--cyl-color-rgb, 0, 255, 136), 0.2);
  border-top-color: var(--cyl-color, #00ff88);
  border-radius: 50%;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.cylinder-row.active .cylinder-spinner {
  animation: cylSpin 0.8s linear infinite;
  opacity: 1;
}

@keyframes cylSpin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.cylinder-cancel-btn {
  display: none;
  margin-top: auto;
  align-self: flex-start;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: rgba(255, 255, 255, 0.5);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.5px;
  padding: 3px 8px;
  cursor: pointer;
  border-radius: 2px;
  text-transform: uppercase;
  transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.cylinder-row.active .cylinder-cancel-btn {
  display: block;
}

.cylinder-cancel-btn:hover {
  background: rgba(255, 0, 85, 0.15);
  border-color: #ff0055;
  color: #ff0055;
}

.cylinder-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-self: stretch;
}

.cylinder-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--cyl-color, #00ff88);
  text-shadow: 0 0 5px var(--cyl-color, rgba(0, 255, 136, 0.5));
  letter-spacing: 0.5px;
}

.cylinder-status-text {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.cylinder-row.active .cylinder-status-text {
  color: rgba(255, 255, 255, 0.8);
}

.phase-section.active .phase-title {
  color: #ffff00;
  text-shadow: 0 0 10px rgba(255, 255, 0, 1);
}

.phase-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  font-size: 12px;
  line-height: 1.6;
}

.phase-content::-webkit-scrollbar {
  width: 8px;
}

.phase-content::-webkit-scrollbar-track {
  background: rgba(0, 255, 136, 0.1);
}

.phase-content::-webkit-scrollbar-thumb {
  background: rgba(0, 255, 136, 0.5);
  border-radius: 4px;
}

.log-line {
  padding: 5px 0;
  animation: fadeIn 0.3s ease-in;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}

.log-line.success {
  color: #00ff88;
}

.log-line.warning {
  color: #ffaa00;
}

.log-line.error {
  color: #ff0055;
}

.log-line.info {
  color: #0088ff;
}

.broadcast-event {
  padding: 12px 14px;
  margin: 8px 0;
  border-left: 3px solid var(--event-color, #ff00ff);
  border-radius: 2px;
  animation: broadcastEventEntry 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  position: relative;
  overflow: hidden;
  cursor: default;
}

.broadcast-event-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.broadcast-event-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.broadcast-event-worker-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.broadcast-event-type {
  font-weight: 700;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 2px;
}

.broadcast-event-time {
  font-size: 10px;
  color: rgba(0, 255, 136, 0.35);
  flex-shrink: 0;
}

.broadcast-event-flow {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  line-height: 1.5;
}

.broadcast-event-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 1px 0;
}

.broadcast-event-row.before-row {
  color: rgba(255, 255, 255, 0.45);
}

.broadcast-event-row.how-row {
  color: rgba(0, 255, 136, 0.65);
  padding-left: 4px;
}

.broadcast-event-row.after-row {
  color: #ffffff;
  font-weight: 600;
}

.broadcast-event-tag {
  display: inline-block;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1.5px;
  padding: 1px 4px;
  border-radius: 2px;
  flex-shrink: 0;
}

.broadcast-event-row.before-row .broadcast-event-tag {
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.5);
}

.broadcast-event-row.how-row .broadcast-event-tag {
  background: rgba(0, 255, 136, 0.15);
  color: rgba(0, 255, 136, 0.8);
  border: 1px solid rgba(0, 255, 136, 0.3);
}

.broadcast-event-row.after-row .broadcast-event-tag {
  color: #000;
}

.broadcast-event-excellence {
  margin-top: 7px;
  padding-top: 5px;
  border-top: 1px solid rgba(255, 255, 136, 0.15);
  font-size: 10px;
  color: rgba(255, 255, 136, 0.75);
  font-style: italic;
  line-height: 1.4;
}

@keyframes broadcastEventEntry {
  0% {
    transform: translateX(50px) scale(0.88);
    opacity: 0;
    filter: brightness(4) blur(4px);
  }
  20% {
    transform: translateX(-6px) scale(1.05);
    opacity: 1;
    filter: brightness(2.5) blur(0);
  }
  55% {
    transform: translateX(2px) scale(1.01);
    filter: brightness(1.4);
  }
  100% {
    transform: translateX(0) scale(1);
    filter: brightness(1);
  }
}

@keyframes broadcastEventExit {
  0% {
    opacity: 1;
    transform: scale(1);
    max-height: 200px;
    margin: 8px 0;
    padding: 12px 14px;
    border-width: 3px;
  }
  40% {
    opacity: 0.3;
    transform: translateX(30px) scale(0.93);
  }
  100% {
    opacity: 0;
    transform: translateX(60px) scale(0.87);
    max-height: 0;
    margin: 0;
    padding: 0;
    border-width: 0;
  }
}

.broadcast-event.exiting {
  animation: broadcastEventExit 0.6s ease-in forwards;
  overflow: hidden;
  pointer-events: none;
}

/* ── Panel C: Event stream ── */
.event-line {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  padding: 2px 0;
  font-size: 10px;
  line-height: 1.5;
  animation: fadeIn 0.2s ease-in;
}

.event-dot {
  flex-shrink: 0;
  font-size: 7px;
  line-height: 16px;
  color: rgba(255, 255, 255, 0.2);
  width: 9px;
  text-align: center;
}

.event-time {
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.22);
  font-size: 9px;
  width: 54px;
}

.event-content {
  flex: 1;
  color: rgba(255, 255, 255, 0.55);
  word-break: break-word;
  overflow: hidden;
}

/* ── Shared animations ── */
@keyframes fadeIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}

/* ── Status bar ── */
.status-bar {
  padding: 10px 24px;
  border-top: 2px solid rgba(0, 255, 136, 0.4);
  background: rgba(10, 14, 39, 0.95);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  z-index: 10;
  font-size: 11px;
  flex-shrink: 0;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #00ff88;
  box-shadow: 0 0 5px rgba(0, 255, 136, 0.8);
}

.status-indicator.active {
  animation: blink 1s ease-in-out infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}

.connection-status {
  padding: 4px 10px;
  border-radius: 2px;
  background: rgba(0, 255, 136, 0.12);
  border: 1px solid rgba(0, 255, 136, 0.4);
}

.connection-status.disconnected {
  background: rgba(255, 0, 85, 0.12);
  border-color: #ff0055;
  color: #ff0055;
}

.stats { display: flex; gap: 20px; flex-wrap: wrap; }
.stat  { display: flex; gap: 8px; }
.stat-value { font-weight: 700; color: #ffff00; }

/* ── GitHub links ── */
a.gh-link {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
a.gh-link:hover {
  text-decoration: underline;
  filter: brightness(1.4);
}
.pill-number a.gh-link {
  color: inherit;
  text-decoration: none;
}
.pill-number a.gh-link:hover {
  text-decoration: underline;
  filter: brightness(1.4);
}

/* ── Cycle start banner ── */
.hidden { display: none !important; }

.cycle-banner {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1000;
  background: rgba(10, 14, 39, 0.97);
  border: 3px solid #ff00ff;
  padding: 36px 56px;
  text-align: center;
  border-radius: 8px;
  box-shadow: 0 0 40px rgba(255, 0, 255, 0.6), inset 0 0 40px rgba(255, 0, 255, 0.08);
  animation: bannerPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.cycle-banner-text {
  font-size: 32px;
  font-weight: 700;
  color: #ff00ff;
  text-shadow: 0 0 20px rgba(255, 0, 255, 1);
  margin: 0;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.cycle-banner-subtext {
  font-size: 16px;
  color: #00ff88;
  margin-top: 12px;
  text-shadow: 0 0 10px rgba(0, 255, 136, 0.8);
}

@keyframes bannerPop {
  0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
  70%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
  100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

@keyframes bannerFadeOut {
  0%   { opacity: 1; }
  100% { opacity: 0; }
}

.cycle-banner.fade-out {
  animation: bannerFadeOut 0.8s ease-out forwards;
}
`;
  }

  private generateJS(owner: string, repo: string, dashboardTitle: string): string {
    const safeTitle = dashboardTitle.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `
const GITHUB_BASE_URL = 'https://github.com/${owner}/${repo}';
const DASHBOARD_TITLE = '${safeTitle}';

// Per-cylinder stable neon identity (issue #21: CYL-1=Cyan, CYL-2=Magenta, CYL-3=Gold)
const CYLINDER_COLORS      = ['#00ffff', '#ff00ff', '#ffd700', '#0088ff', '#ff6600', '#aa00ff'];
const CYLINDER_COLORS_RGB  = ['0,255,255', '255,0,255', '255,215,0', '0,136,255', '255,102,0', '170,0,255'];
const CYLINDER_COLOR_NAMES = ['CYAN', 'MAGENTA', 'GOLD', 'BLUE', 'ORANGE', 'PURPLE'];

function escHtml(text) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(text)));
  return d.innerHTML;
}

function formatModelName(modelId) {
  if (!modelId) return null;
  const stripped = modelId.replace(/^claude-/i, '');
  const parts = stripped.split('-');
  let nameEnd = parts.length;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d/.test(parts[i])) { nameEnd = i; break; }
  }
  const nameParts = parts.slice(0, nameEnd).map(p => p.charAt(0).toUpperCase() + p.slice(1));
  const versionParts = parts.slice(nameEnd);
  let result = 'Claude ' + nameParts.join(' ');
  if (versionParts.length > 0) result += ' ' + versionParts.join('.');
  return result;
}

class DashboardUI {
  constructor() {
    this.appContainer = document.getElementById('app');
    this.events = [];
    this.maxConcurrency = 3;
    this.cylinders = [];
    this.initCylinders(this.maxConcurrency);
    this.issueCards = new Map();  // issueNumber -> {number,title,state}
    this.prCards = new Map();     // prNumber -> {number,title,state,draft,checksStatus,...}
    this.cylinderByIssue = new Map(); // issueNumber -> cylinderIdx (0-based)
    this.cylinderByPR = new Map();    // prNumber -> cylinderIdx (0-based)
    this.lastLifecyclePairs = [];     // most recent pairs from server, for client-side resort
    this.connected = false;
    this.broadcastQueue = [];
    this.broadcastProcessing = false;
    this.BROADCAST_FANFARE_MS = 3000;
    this.BROADCAST_MAX_ITEMS = 15;
    this.workerColors = CYLINDER_COLORS.slice();
    this.workerMap = {};
    this.ws = null;
    this.shutdownRequested = false;
    this.appShutdown = false;
    this.init();
  }

  init() {
    this.render();
    this.connectWebSocket();
    // Tick every second to keep elapsed-time and countdown displays current
    setInterval(() => this.renderPanelA(), 1000);
  }

  initCylinders(n) {
    this.maxConcurrency = n;
    this.cylinders = [];
    for (let i = 0; i < n; i++) {
      this.cylinders.push({
        index: i + 1,
        color: CYLINDER_COLORS[i % CYLINDER_COLORS.length],
        colorRgb: CYLINDER_COLORS_RGB[i % CYLINDER_COLORS_RGB.length],
        colorName: CYLINDER_COLOR_NAMES[i % CYLINDER_COLOR_NAMES.length],
        status: 'idle',
        idleStatusText: 'idle',
        actionType: null,
        issueNumber: null,
        prNumber: null,
        model: null,
        iterationNumber: 0,
        actionStartedAt: null,
        nextCycleAtMs: null,
        rateLimitedUntilMs: null,
      });
    }
  }

  render() {
    this.appContainer.innerHTML = \`
      <div class="header">
        <div>
          <div class="header-title"><a class="gh-link" href="\${GITHUB_BASE_URL}" target="_blank" rel="noopener noreferrer">⚡ \${DASHBOARD_TITLE}</a> <span>AI SDLC BROADCAST</span></div>
        </div>
      </div>
      <div class="main-content">
        <div class="panel panel-a">
          <div class="panel-header" id="panel-a-header">⚙ ${this.maxConcurrency}-CYLINDER ENGINE</div>
          <div class="panel-body" id="cylinder-list"></div>
        </div>
        <div class="panel panel-b">
          <div class="panel-header">⚡ ISSUE→PR LIFECYCLE <span id="lifecycle-subtitle">_ items · _ in progress</span></div>
          <div class="panel-body">
            <div class="lifecycle-header">
              <!-- Removed the redundant title -->
              <div id="lifecycle-content" class="lifecycle-content">
                <div class="lifecycle-empty">Connecting to vibrator…</div>
              </div>
            </div>
          </div>
        </div>
        <div class="panel panel-c">
          <div class="panel-header">📡 Broadcast Feed</div>
          <div class="panel-body" id="phase-broadcast-content"></div>
        </div>
      </div>
      <div class="status-bar">
        <div class="status-item">
          <div class="status-indicator active"></div>
          <span>Dashboard Active</span>
        </div>
        <div class="stats">
          <div class="stat">
            <span>Events:</span>
            <span class="stat-value" id="event-count">0</span>
          </div>
          <div class="stat">
            <span>Sessions:</span>
            <span class="stat-value" id="session-count">0</span>
          </div>
        </div>
        <div class="connection-status" id="connection-status">
          <span id="connection-text">Connecting...</span>
        </div>
      </div>
    \`;
    this.renderPanelA();
  }

  // ── Panel A: N-Cylinder Engine ──────────────────────────────────────────
  renderPanelA() {
    const list = document.getElementById('cylinder-list');
    if (!list) return;

    for (let i = 0; i < this.cylinders.length; i++) {
      const cyl = this.cylinders[i];
      const rowId = \`cylinder-row-\${i}\`;

      const isActive   = cyl.status === 'active';
      const isDone     = cyl.status === 'done';
      const isError    = cyl.status === 'error';
      const isShutdown = cyl.status === 'shutdown';

      let statusHTML;
      if (isShutdown) {
        statusHTML = '⏹ shutdown';
      } else if (isActive || isDone || isError) {
        const issueLink = cyl.issueNumber != null
          ? \`<a class="gh-link" href="\${GITHUB_BASE_URL}/issues/\${cyl.issueNumber}" target="_blank" rel="noopener noreferrer">#\${cyl.issueNumber}</a>\`
          : '';
        const prLink = cyl.prNumber != null
          ? \`<a class="gh-link" href="\${GITHUB_BASE_URL}/pull/\${cyl.prNumber}" target="_blank" rel="noopener noreferrer">PR #\${cyl.prNumber}</a>\`
          : '';
        switch (cyl.actionType) {
          case 'start-implementation':
            statusHTML = \`implementing \${issueLink}\`;
            break;
          case 'self-review':
            statusHTML = \`reviewing \${prLink}\`;
            break;
          case 'address-failing-checks':
            statusHTML = \`fixing checks \${prLink}\`;
            break;
          case 'squash-merge':
            statusHTML = \`merging \${prLink}\`;
            break;
          case 'resolve-conflicts':
            statusHTML = \`resolving conflicts \${prLink}\`;
            break;
          default:
            statusHTML = escHtml(cyl.actionType || 'working');
        }
        if (isDone)  statusHTML = \`✓ \${statusHTML}\`;
        if (isError) statusHTML = \`✗ \${statusHTML}\`;
        if (isActive && cyl.actionStartedAt) {
          statusHTML += \` · \${this.formatDuration(Date.now() - cyl.actionStartedAt)}\`;
        }
      } else {
        // idle — show live countdown or rate-limit info
        const now = Date.now();
        if (cyl.rateLimitedUntilMs && cyl.rateLimitedUntilMs > now) {
          statusHTML = \`rate limited · \${this.formatDuration(cyl.rateLimitedUntilMs - now)}\`;
        } else if (cyl.nextCycleAtMs && cyl.nextCycleAtMs > now) {
          statusHTML = this.formatDuration(cyl.nextCycleAtMs - now);
        } else {
          statusHTML = escHtml(cyl.idleStatusText || 'idle');
        }
      }

      const isIdle = !isActive && !isDone && !isError && !isShutdown;
      const modelLabel = isIdle
        ? 'Idle'
        : (formatModelName(cyl.model) || \`CYL \${cyl.index}\`);
      const cycleLabel = (isActive || isDone || isError) && cyl.iterationNumber > 0 ? \` #\${cyl.iterationNumber}\` : '';
      const dotClass = isActive ? 'cylinder-dot pulsing' : 'cylinder-dot';

      let row = document.getElementById(rowId);
      if (!row) {
        row = document.createElement('div');
        row.id = rowId;
        row.className = \`cylinder-row \${cyl.status}\`;
        row.style.setProperty('--cyl-color', cyl.color);
        row.style.setProperty('--cyl-color-rgb', cyl.colorRgb);
        row.innerHTML = \`
          <div class="\${dotClass}"></div>
          <div class="cylinder-info">
            <div class="cylinder-label">\${escHtml(modelLabel)}\${cycleLabel}</div>
            <div class="cylinder-status-text">\${statusHTML}</div>
            <button class="cylinder-cancel-btn" onclick="dashboard.cancelCylinder(\${i})">Cancel</button>
          </div>
          <div class="cylinder-spinner"></div>
        \`;
        list.appendChild(row);
      } else {
        const newRowClass = \`cylinder-row \${cyl.status}\`;
        if (row.className !== newRowClass) row.className = newRowClass;
        row.style.setProperty('--cyl-color', cyl.color);
        row.style.setProperty('--cyl-color-rgb', cyl.colorRgb);

        const dot = row.querySelector('.cylinder-dot');
        if (dot && dot.className !== dotClass) dot.className = dotClass;

        const labelEl = row.querySelector('.cylinder-label');
        const newLabel = escHtml(modelLabel) + cycleLabel;
        if (labelEl && labelEl.innerHTML !== newLabel) labelEl.innerHTML = newLabel;

        const statusEl = row.querySelector('.cylinder-status-text');
        if (statusEl && statusEl.innerHTML !== statusHTML) statusEl.innerHTML = statusHTML;
      }
    }

    // Remove stale rows if cylinder count shrank
    for (let i = this.cylinders.length; ; i++) {
      const stale = document.getElementById(\`cylinder-row-\${i}\`);
      if (!stale) break;
      stale.remove();
    }

    const header = document.getElementById('panel-a-header');
    if (header && !this.shutdownRequested && !this.appShutdown) {
      header.textContent = \`⚙ \${this.maxConcurrency}-CYLINDER ENGINE\`;
    }
  }

  // ── Panel B: Issue→PR Lifecycle ─────────────────────────────────────────
  renderPanelB() {
    const list = document.getElementById('lifecycle-list');
    if (!list) return;
    list.innerHTML = '';

    if (this.issueCards.size === 0 && this.prCards.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'lifecycle-empty';
      empty.textContent = 'Waiting for repository snapshot…';
      list.appendChild(empty);
      return;
    }

    // Build issue → linked-PR pairs
    const pairs = [];
    const handledPRs = new Set();

    for (const [issueNum, issue] of this.issueCards) {
      const linkedPRs = [];
      for (const [prNum, pr] of this.prCards) {
        const closes = pr.closingIssueNumbers || [];
        const linked  = pr.linkedIssueNumbers  || [];
        if (closes.includes(issueNum) || linked.includes(issueNum)) {
          linkedPRs.push(pr);
          handledPRs.add(prNum);
        }
      }
      pairs.push({ issue, prs: linkedPRs });
    }

    // Orphan PRs (no linked issue)
    for (const [prNum, pr] of this.prCards) {
      if (!handledPRs.has(prNum)) pairs.push({ issue: null, prs: [pr] });
    }

    // Active-cylinder items float to top, then sort by issue number
    pairs.sort((a, b) => {
      const aActive = a.issue ? this.cylinderByIssue.has(a.issue.number) : false;
      const bActive = b.issue ? this.cylinderByIssue.has(b.issue.number) : false;
      if (aActive !== bActive) return aActive ? -1 : 1;
      if (a.issue && b.issue) return a.issue.number - b.issue.number;
      return 0;
    });

    for (const pair of pairs.slice(0, 20)) {
      list.appendChild(this.createLifecycleCard(pair));
    }
  }

  createLifecycleCard({ issue, prs }) {
    const card = document.createElement('div');

    // Resolve cylinder color for this card
    let cylinderIdx = -1;
    if (issue) {
      const idx = this.cylinderByIssue.get(issue.number);
      if (idx !== undefined) cylinderIdx = idx;
    }
    if (cylinderIdx === -1) {
      for (const pr of prs) {
        const idx = this.cylinderByPR.get(pr.number);
        if (idx !== undefined) { cylinderIdx = idx; break; }
      }
    }

    const color = cylinderIdx >= 0
      ? CYLINDER_COLORS[cylinderIdx % CYLINDER_COLORS.length]
      : 'rgba(0, 255, 136, 0.22)';

    card.className = \`lifecycle-card\${cylinderIdx >= 0 ? ' active' : ''}\`;
    card.style.setProperty('--card-color', color);

    let html = '';

    if (issue) {
      const t = issue.title.length > 30 ? issue.title.slice(0, 30) + '…' : issue.title;
      html += \`<div class="lifecycle-pill issue-pill">
        <div class="pill-number">Issue #\${issue.number}</div>
        <div class="pill-title">\${escHtml(t)}</div>
        <div class="pill-state">\${escHtml(issue.state.toUpperCase())}</div>
      </div>\`;
    }

    if (prs.length > 0) {
      if (issue) html += \`<div class="lifecycle-arrow">→</div>\`;
      for (const pr of prs) {
        const t = pr.title.length > 30 ? pr.title.slice(0, 30) + '…' : pr.title;
        const checkIcon =
          pr.checksStatus === 'success' ? '✅' :
          pr.checksStatus === 'failure' ? '❌' :
          pr.checksStatus === 'pending' ? '⏳' : '⚪';
        html += \`<div class="lifecycle-pill pr-pill">
          <div class="pill-number">PR #\${pr.number}</div>
          <div class="pill-title">\${escHtml(t)}</div>
          <div class="pill-state">\${pr.draft ? 'DRAFT' : 'READY'} \${checkIcon}</div>
        </div>\`;
      }
    }

    card.innerHTML = html;
    return card;
  }

  // ── Panel C: Event Stream ───────────────────────────────────────────────
  addEventToStream(text, cylinderIdx, level) {
    const stream = document.getElementById('event-stream');
    if (!stream) return;

    const color =
      cylinderIdx >= 0
        ? CYLINDER_COLORS[cylinderIdx % CYLINDER_COLORS.length]
        : null;

    const line = document.createElement('div');
    line.className = 'event-line';

    const dot = document.createElement('span');
    dot.className = 'event-dot';
    dot.textContent = '●';
    if (color) { dot.style.color = color; dot.style.textShadow = \`0 0 5px \${color}\`; }

    const timeEl = document.createElement('span');
    timeEl.className = 'event-time';
    timeEl.textContent = new Date().toLocaleTimeString('en', { hour12: false });

    const content = document.createElement('span');
    content.className = 'event-content';
    content.textContent = text;
    if (color) {
      content.style.color = color;
    } else if (level === 'error') {
      content.style.color = '#ff0055';
    } else if (level === 'success') {
      content.style.color = '#00ff88';
    } else if (level === 'warning') {
      content.style.color = '#ffaa00';
    }

    line.appendChild(dot);
    line.appendChild(timeEl);
    line.appendChild(content);
    stream.appendChild(line);
    stream.scrollTop = stream.scrollHeight;

    while (stream.children.length > 300) stream.removeChild(stream.firstChild);
  }

  // ── WebSocket ───────────────────────────────────────────────────────────
  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

    this.ws.onopen = () => {
      this.connected = true;
      this.updateConnectionStatus(true);
      this.addEventToStream('Connected to vibrator dashboard', -1, 'success');
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    this.ws.onerror = () => this.updateConnectionStatus(false);

    this.ws.onclose = () => {
      this.connected = false;
      this.updateConnectionStatus(false);
      setTimeout(() => this.connectWebSocket(), 3000);
    };
  }

  cancelCylinder(engineIndex) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cylinder-cancel-request', engineIndex }));
    }
  }

  handleMessage(message) {
    if (!message.type) return;

    this.events.push(message);
    if (this.events.length > 1000) this.events.shift();
    const countEl = document.getElementById('event-count');
    if (countEl) countEl.textContent = this.events.length;

    switch (message.type) {
      case 'iteration-start':        this.handleIterationStart(message); break;
      case 'phase-update':           this.handlePhaseUpdate(message); break;
      case 'action-start':           this.handleActionStart(message); break;
      case 'action-complete':        this.handleActionComplete(message); break;
      case 'action-error':           this.handleActionError(message); break;
      case 'workflow-approval':      this.handleWorkflowApproval(message); break;
      case 'snapshot-update':        this.handleSnapshotUpdate(message); break;
      case 'broadcast-github-activity':
      case 'broadcast-commit':
      case 'broadcast-pr-update':
      case 'broadcast-ci-status':
      case 'broadcast-review-comment':
      case 'broadcast-issue-update':
        this.handleBroadcastEvent(message);
        break;
      case 'lifecycle-update':
        this.handleLifecycleUpdate(message);
        break;
      case 'log-message':
        this.handleLogMessage(message);
        break;
      case 'engine-idle':
        this.handleEngineIdle(message);
        break;
      case 'shutdown-requested':
        this.handleShutdownRequested(message);
        break;
      case 'engine-shutdown':
        this.handleEngineShutdown(message);
        break;
      case 'app-shutdown':
        this.handleAppShutdown(message);
        break;
      case 'cylinder-cancel':
        this.handleCylinderCancel(message);
        break;
      default:
        this.addEventToStream(\`[EVENT] \${message.type}\`, -1, 'info');
    }
  }

  // ── Event handlers ──────────────────────────────────────────────────────
  handleIterationStart(message) {
    const engineIndex = message.data.engineIndex !== undefined ? message.data.engineIndex : 0;
    const iterationNumber = message.data.iterationNumber;
    const n = message.data.maxConcurrency || this.maxConcurrency;

    if (n !== this.maxConcurrency) {
      this.initCylinders(n);
    }

    if (this.cylinders[engineIndex]) {
      const cyl = this.cylinders[engineIndex];

      // Clear stale issue/PR mappings so Panel B stops showing this engine as active
      if (cyl.issueNumber != null && this.cylinderByIssue.get(cyl.issueNumber) === engineIndex) {
        this.cylinderByIssue.delete(cyl.issueNumber);
      }
      if (cyl.prNumber != null && this.cylinderByPR.get(cyl.prNumber) === engineIndex) {
        this.cylinderByPR.delete(cyl.prNumber);
      }

      cyl.iterationNumber = iterationNumber;
      cyl.status = 'idle';
      cyl.issueNumber = null;
      cyl.prNumber = null;
      cyl.actionType = null;
      cyl.idleStatusText = 'idle';
      cyl.actionStartedAt = null;
      cyl.nextCycleAtMs = null;
      cyl.rateLimitedUntilMs = null;
    }

    this.renderPanelA();
    this.recolorAllPills();
    this.resortLifecyclePills();
    this.addEventToStream(
      \`🔄 Engine \${engineIndex + 1} · cycle \${iterationNumber}\`, engineIndex, 'info'
    );
  }

  handlePhaseUpdate(message) {
    this.addEventToStream(\`📍 Phase: \${message.data.phase}\`, -1, 'info');
  }

  handleActionStart(message) {
    const idx = (message.data.actionIndex || 1) - 1;

    if (idx >= 0 && idx < this.cylinders.length) {
      const cyl = this.cylinders[idx];

      // Clear stale mappings from this cylinder's previous action
      if (cyl.issueNumber != null && this.cylinderByIssue.get(cyl.issueNumber) === idx) {
        this.cylinderByIssue.delete(cyl.issueNumber);
      }
      if (cyl.prNumber != null && this.cylinderByPR.get(cyl.prNumber) === idx) {
        this.cylinderByPR.delete(cyl.prNumber);
      }

      cyl.status = 'active';
      cyl.actionType = message.data.type || null;
      cyl.idleStatusText = null;
      cyl.issueNumber = message.data.issueNumber ?? null;
      cyl.prNumber = message.data.pullRequestNumber ?? null;
      cyl.model = message.data.model ?? null;
      cyl.actionStartedAt = typeof message.data.startedAt === 'number' ? message.data.startedAt : Date.now();
      cyl.nextCycleAtMs = null;
      cyl.rateLimitedUntilMs = null;

      if (cyl.issueNumber != null) this.cylinderByIssue.set(cyl.issueNumber, idx);
      if (cyl.prNumber != null)    this.cylinderByPR.set(cyl.prNumber, idx);

      this.renderPanelA();
      this.recolorAllPills();
      this.resortLifecyclePills();
    }

    const actionDesc = message.data.description || message.data.type || 'action';
    this.addEventToStream(
      \`▶ [\${message.data.actionIndex}/\${message.data.totalActions}] \${actionDesc}\`,
      idx, 'info'
    );
  }

  handleActionComplete(message) {
    const idx = (message.data.actionIndex || 1) - 1;
    if (idx >= 0 && idx < this.cylinders.length) {
      this.cylinders[idx].status = 'done';
      this.renderPanelA();
    }
    this.addEventToStream(
      \`✓ action [\${message.data.actionIndex}/\${message.data.totalActions}] complete\`, idx, 'success'
    );
  }

  handleActionError(message) {
    const idx = (message.data.actionIndex || 1) - 1;
    if (idx >= 0 && idx < this.cylinders.length) {
      this.cylinders[idx].status = 'error';
      this.renderPanelA();
    }
    this.addEventToStream(
      \`✗ action [\${message.data.actionIndex}/\${message.data.totalActions}] failed: \${message.data.error || ''}\`,
      idx, 'error'
    );
  }

  handleEngineIdle(message) {
    const engineIndex = message.data.engineIndex;
    if (engineIndex !== undefined && this.cylinders[engineIndex]) {
      const cyl = this.cylinders[engineIndex];

      if (cyl.issueNumber != null && this.cylinderByIssue.get(cyl.issueNumber) === engineIndex) {
        this.cylinderByIssue.delete(cyl.issueNumber);
      }
      if (cyl.prNumber != null && this.cylinderByPR.get(cyl.prNumber) === engineIndex) {
        this.cylinderByPR.delete(cyl.prNumber);
      }

      const reason = typeof message.data.reason === 'string' ? message.data.reason : '';
      const nextCycleAtMs = typeof message.data.nextCycleAtMs === 'number' ? message.data.nextCycleAtMs : null;
      const rateLimitedUntilMs = typeof message.data.rateLimitedUntilMs === 'number' ? message.data.rateLimitedUntilMs : null;

      cyl.idleStatusText = reason || 'idle';
      cyl.nextCycleAtMs = nextCycleAtMs;
      cyl.rateLimitedUntilMs = rateLimitedUntilMs;

      cyl.status = 'idle';
      cyl.issueNumber = null;
      cyl.prNumber = null;
      cyl.actionType = null;
      cyl.actionStartedAt = null;

      this.renderPanelA();
      this.recolorAllPills();
      this.resortLifecyclePills();
    }
  }

  handleShutdownRequested(message) {
    this.shutdownRequested = true;
    const header = document.getElementById('panel-a-header');
    if (header) header.textContent = \`⚙ SHUTTING DOWN\`;
    this.addEventToStream('⏹ Shutdown requested — engines will stop after current cycle', -1, 'warning');
  }

  handleEngineShutdown(message) {
    const engineIndex = message.data.engineIndex;
    if (engineIndex !== undefined && this.cylinders[engineIndex]) {
      const cyl = this.cylinders[engineIndex];

      if (cyl.issueNumber != null && this.cylinderByIssue.get(cyl.issueNumber) === engineIndex) {
        this.cylinderByIssue.delete(cyl.issueNumber);
      }
      if (cyl.prNumber != null && this.cylinderByPR.get(cyl.prNumber) === engineIndex) {
        this.cylinderByPR.delete(cyl.prNumber);
      }

      cyl.status = 'shutdown';
      cyl.issueNumber = null;
      cyl.prNumber = null;
      cyl.actionType = null;
      cyl.actionStartedAt = null;
      cyl.idleStatusText = null;

      this.renderPanelA();
      this.recolorAllPills();
      this.resortLifecyclePills();
    }
    this.addEventToStream(
      \`⏹ Engine \${(engineIndex ?? 0) + 1} shut down\`,
      engineIndex !== undefined ? engineIndex : -1, 'warning'
    );
  }

  handleAppShutdown(message) {
    this.appShutdown = true;
    const header = document.getElementById('panel-a-header');
    if (header) header.textContent = \`⚙ SHUT DOWN\`;
    const statusEl = document.getElementById('connection-status');
    const textEl = document.getElementById('connection-text');
    if (statusEl && textEl) {
      statusEl.classList.add('disconnected');
      statusEl.style.cssText = 'background:rgba(255,102,0,0.12);border-color:#ff6600;color:#ff6600;';
      textEl.textContent = '⏹ SHUTDOWN';
    }
    this.addEventToStream('⏹ Vibrator shutdown complete', -1, 'warning');
  }

  handleCylinderCancel(message) {
    const engineIndex = message.data.engineIndex;
    if (engineIndex !== undefined && this.cylinders[engineIndex]) {
      const cyl = this.cylinders[engineIndex];
      cyl.nextCycleAtMs = null;
      cyl.idleStatusText = 'cancelling…';
      this.renderPanelA();
    }
    const idx = typeof engineIndex === 'number' ? engineIndex : -1;
    this.addEventToStream(\`⊗ Engine \${idx + 1} cancel requested\`, idx, 'warning');
  }

  handleWorkflowApproval(message) {
    const runName = message.data.runName || 'unknown';
    const runId = message.data.runId;
    this.enqueueBroadcastEvent({
      category: 'ci',
      label: 'WORKFLOW',
      stateBefore: 'Workflow "' + runName + '" was awaiting approval',
      changeHow: 'Vibrator automatically approved the workflow run',
      stateAfter: '✅ Workflow "' + runName + '" approved and queued',
      excellence: 'CI pipeline unblocked — automated approval keeps development flowing',
      workerIndex: undefined,
      runId,
    });
  }

  handleLogMessage(message) {
    this.addEventToStream(message.data.message || '', -1, message.data.level || 'info');
  }

  handleSnapshotUpdate(message) {
    const data = message.data;
    const sessionEl = document.getElementById('session-count');
    if (sessionEl) sessionEl.textContent = data.sessionCount || 0;

    if (Array.isArray(data.issues)) {
      this.issueCards.clear();
      for (const issue of data.issues) this.issueCards.set(issue.number, issue);
    }
    if (Array.isArray(data.pullRequests)) {
      this.prCards.clear();
      for (const pr of data.pullRequests) this.prCards.set(pr.number, pr);
    }

    this.addEventToStream(
      \`📊 Snapshot: \${data.issueCount || 0} issues, \${data.prCount || 0} PRs, \${data.sessionCount || 0} sessions\`,
      -1, 'info'
    );
  }

  handleBroadcastEvent(message) {
    const category = message.type === 'broadcast-ci-status' ? 'ci' :
                     message.type === 'broadcast-commit' ? 'commit' :
                     message.type === 'broadcast-pr-update' ? 'pr' :
                     message.type === 'broadcast-issue-update' ? 'issue' : 'info';

    const label = message.type.replace('broadcast-', '').replace(/-/g, ' ').toUpperCase();

    let workerIndex = message.data.workerIndex !== undefined ? message.data.workerIndex : undefined;
    if (workerIndex === undefined) {
      const prNum = message.data.prNumber;
      const issueNum = message.data.issueNumber;
      if (prNum !== undefined) workerIndex = this.workerMap['pr:' + prNum];
      if (issueNum !== undefined && workerIndex === undefined) workerIndex = this.workerMap['issue:' + issueNum];
    }

    this.enqueueBroadcastEvent({
      category,
      label,
      stateBefore: message.data.stateBefore || message.data.content || '',
      changeHow: message.data.changeHow || '',
      stateAfter: message.data.stateAfter || '',
      excellence: message.data.excellence || '',
      workerIndex,
      prNumber: message.data.prNumber,
      issueNumber: message.data.issueNumber,
      commitHash: message.data.hash,
    });
  }

  enqueueBroadcastEvent(eventData) {
    this.broadcastQueue.push(eventData);
    if (!this.broadcastProcessing) {
      this.processNextBroadcastEvent();
    }
  }

  formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return \`\${minutes}m \${seconds}s\`;
    return \`\${seconds}s\`;
  }

  processNextBroadcastEvent() {
    if (this.broadcastQueue.length === 0) {
      this.broadcastProcessing = false;
      return;
    }
    this.broadcastProcessing = true;
    const eventData = this.broadcastQueue.shift();
    this.displayBroadcastEvent(eventData);
    setTimeout(() => this.processNextBroadcastEvent(), this.BROADCAST_FANFARE_MS);
  }

  getWorkerColor(category, workerIndex) {
    if (workerIndex !== undefined && workerIndex !== null && workerIndex >= 0) {
      return this.workerColors[workerIndex % this.workerColors.length];
    }
    const categoryColors = { commit: '#00ff88', pr: '#0088ff', ci: '#ffff00', issue: '#ff6600' };
    return (category && categoryColors[category]) || '#ff00ff';
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(text)));
    return div.innerHTML;
  }

  linkifyText(text, context) {
    let out = this.escapeHtml(text);
    // Linkify "PR #N"
    out = out.replace(/\\bPR #(\\d+)\\b/g, function(_, n) {
      return 'PR <a class="gh-link" href="' + GITHUB_BASE_URL + '/pull/' + n + '" target="_blank" rel="noopener noreferrer">#' + n + '</a>';
    });
    // Linkify "Issue #N"
    out = out.replace(/\\bIssue #(\\d+)\\b/g, function(_, n) {
      return 'Issue <a class="gh-link" href="' + GITHUB_BASE_URL + '/issues/' + n + '" target="_blank" rel="noopener noreferrer">#' + n + '</a>';
    });
    // Linkify commit short hash
    if (context && context.commitHash) {
      const shortHash = context.commitHash.slice(0, 7);
      const idx = out.indexOf(shortHash);
      if (idx !== -1) {
        out = out.slice(0, idx) + '<a class="gh-link" href="' + GITHUB_BASE_URL + '/commit/' + context.commitHash + '" target="_blank" rel="noopener noreferrer">' + shortHash + '</a>' + out.slice(idx + 7);
      }
    }
    // Linkify workflow run names when a runId is available
    if (context && context.runId) {
      const runId = context.runId;
      out = out.replace(/Workflow &quot;([^&]+)&quot;/g, function(_, name) {
        return 'Workflow &quot;<a class="gh-link" href="' + GITHUB_BASE_URL + '/actions/runs/' + runId + '" target="_blank" rel="noopener noreferrer">' + name + '</a>&quot;';
      });
    }
    return out;
  }

  displayBroadcastEvent(eventData) {
    const broadcastContent = document.getElementById('phase-broadcast-content');
    if (!broadcastContent) return;

    const { category, label, stateBefore, changeHow, stateAfter, excellence, workerIndex } = eventData;
    const color = this.getWorkerColor(category, workerIndex);
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const time = new Date().toLocaleTimeString();

    const ctx = {
      prNumber: eventData.prNumber,
      issueNumber: eventData.issueNumber,
      commitHash: eventData.commitHash,
      runId: eventData.runId,
    };

    const card = document.createElement('div');
    card.className = 'broadcast-event';
    card.style.cssText = 'border-left-color:' + color + ';background:rgba(' + r + ',' + g + ',' + b + ',0.07);';

    const nowTagStyle = 'background:' + color + ';';
    const dotStyle = 'background:' + color + ';box-shadow:0 0 6px ' + color + ';';
    const typeStyle = 'color:' + color + ';';

    const excellenceHtml = excellence
      ? '<div class="broadcast-event-excellence">✨ ' + this.linkifyText(excellence, ctx) + '</div>'
      : '';

    card.innerHTML =
      '<div class="broadcast-event-header">'
      + '<div class="broadcast-event-header-left">'
      + '<span class="broadcast-event-worker-dot" style="' + dotStyle + '"></span>'
      + '<span class="broadcast-event-type" style="' + typeStyle + '">' + this.escapeHtml(label || (category || 'event').toUpperCase()) + '</span>'
      + '</div>'
      + '<span class="broadcast-event-time">' + time + '</span>'
      + '</div>'
      + '<div class="broadcast-event-flow">'
      + '<div class="broadcast-event-row before-row">'
      + '<span class="broadcast-event-tag">WAS</span>'
      + '<span>' + this.linkifyText(stateBefore || '', ctx) + '</span>'
      + '</div>'
      + '<div class="broadcast-event-row how-row">'
      + '<span class="broadcast-event-tag">HOW</span>'
      + '<span>' + this.linkifyText(changeHow || '', ctx) + '</span>'
      + '</div>'
      + '<div class="broadcast-event-row after-row">'
      + '<span class="broadcast-event-tag" style="' + nowTagStyle + '">NOW</span>'
      + '<span>' + this.linkifyText(stateAfter || '', ctx) + '</span>'
      + '</div>'
      + '</div>'
      + excellenceHtml;

    // Newest events appear at top — conveyor belt pushes older ones down
    if (broadcastContent.firstChild) {
      broadcastContent.insertBefore(card, broadcastContent.firstChild);
    } else {
      broadcastContent.appendChild(card);
    }
    broadcastContent.scrollTop = 0;

    // Evict oldest items beyond limit with slide-away animation
    const children = broadcastContent.children;
    if (children.length > this.BROADCAST_MAX_ITEMS) {
      const toEvict = children[this.BROADCAST_MAX_ITEMS];
      if (toEvict && !toEvict.classList.contains('exiting')) {
        toEvict.classList.add('exiting');
        const evictTarget = toEvict;
        setTimeout(function() {
          if (evictTarget.parentNode) evictTarget.parentNode.removeChild(evictTarget);
        }, 650);
      }
    }
  }

  getCurrentPhaseContent() {
    const phase = this.currentPhase || 'implementation';
    return document.getElementById(\`phase-\${phase}-content\`);
  }

  handleLifecycleUpdate(message) {
    const pairs = message.data.pairs;
    if (!Array.isArray(pairs)) return;

    this.lastLifecyclePairs = pairs;

    const content = document.getElementById('lifecycle-content');
    if (!content) return;

    if (pairs.length === 0) {
      content.innerHTML = '<div class="lifecycle-empty">⚡ All issues complete — repository is clean</div>';
      this.updateLifecycleSubtitle(pairs);
      return;
    }

    this.updateLifecycleSubtitle(pairs);

    content.querySelector('.lifecycle-empty')?.remove();

    const sorted = [...pairs].sort((a, b) => this.compareLifecyclePairs(a, b));

    const existingKeys = new Set(
      [...content.querySelectorAll('.lifecycle-pill')].map(el => el.dataset.pairKey)
    );
    const incomingKeys = new Set(sorted.map(p => this.pairKey(p)));

    for (const key of existingKeys) {
      if (!incomingKeys.has(key)) {
        content.querySelector('[data-pair-key="' + key + '"]')?.remove();
      }
    }

    // Create or update pills without moving existing ones
    for (const pair of sorted) {
      const key = this.pairKey(pair);
      let pill = content.querySelector('[data-pair-key="' + key + '"]');
      if (!pill) {
        pill = this.createPill(pair);
        content.appendChild(pill);
      } else {
        this.updatePill(pill, pair);
      }
    }

    // Reorder pills only when the DOM order doesn't already match the sorted order
    const domOrder = [...content.querySelectorAll('.lifecycle-pill')].map(el => el.dataset.pairKey);
    const sortedOrder = sorted.map(p => this.pairKey(p));
    const needsReorder = domOrder.length !== sortedOrder.length ||
                         domOrder.some((key, idx) => key !== sortedOrder[idx]);
    if (needsReorder) {
      for (const pair of sorted) {
        const pill = content.querySelector('[data-pair-key="' + this.pairKey(pair) + '"]');
        if (pill) content.appendChild(pill);
      }
    }
  }

  /**
   * Pair sort order — matches phaseSortPriority on the server:
   *   tier 0: review   (non-draft PR: needs human review)
   *   tier 1: active   (draft PR: bot still working)
   *   tier 2: completed (has PR, merged)
   *   tier 3: planning (being implemented, no PR yet)
   *   tier 4: absent unblocked
   *   tier 5: absent blocked
   * Rows currently on an engine cylinder always sort first, ahead of every
   * other row regardless of tier, ordered by cylinder index (matching the
   * engine panel order). The rest sort by tier, then by issue number.
   */
  compareLifecyclePairs(a, b) {
    const aCyl = a.issue ? this.cylinderByIssue.get(a.issue.number) : undefined;
    const bCyl = b.issue ? this.cylinderByIssue.get(b.issue.number) : undefined;
    const aOnCyl = aCyl !== undefined;
    const bOnCyl = bCyl !== undefined;
    if (aOnCyl && bOnCyl) return aCyl - bCyl;
    if (aOnCyl !== bOnCyl) return aOnCyl ? -1 : 1;

    const ap = this.lifecycleTier(a);
    const bp = this.lifecycleTier(b);
    if (ap !== bp) return ap - bp;

    // Orphan PRs (no issue) sort by PR number within their tier.
    const aNum = a.issue ? a.issue.number : a.pr.number;
    const bNum = b.issue ? b.issue.number : b.pr.number;
    return aNum - bNum;
  }

  lifecycleTier(pair) {
    if (pair.prPhase === 'review') return 0;
    if (pair.prPhase === 'active') return 1;
    if (pair.prPhase === 'completed') return 2;
    if (pair.prPhase === 'planning') return 3;
    if (pair.prPhase === 'inactive') return 6;
    const blocked = pair.blockedByIssueNumbers && pair.blockedByIssueNumbers.length > 0;
    return blocked ? 5 : 4;
  }

  countInProgressLifecyclePairs(pairs) {
    return pairs.filter(pair => pair.issue && this.cylinderByIssue.has(pair.issue.number)).length;
  }

  updateLifecycleSubtitle(pairs = this.lastLifecyclePairs) {
    const subtitle = document.getElementById('lifecycle-subtitle');
    if (!subtitle) return;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      subtitle.textContent = 'done';
      return;
    }

    const inProgress = this.countInProgressLifecyclePairs(pairs);
    subtitle.textContent = String(pairs.length)
      + ' item' + (pairs.length !== 1 ? 's' : '')
      + ' · ' + String(inProgress) + ' in progress';
  }

  resortLifecyclePills() {
    if (!this.lastLifecyclePairs || this.lastLifecyclePairs.length === 0) return;
    const content = document.getElementById('lifecycle-content');
    if (!content) return;
    const sorted = [...this.lastLifecyclePairs].sort((a, b) => this.compareLifecyclePairs(a, b));
    const domOrder = [...content.querySelectorAll('.lifecycle-pill')].map(el => el.dataset.pairKey);
    const sortedOrder = sorted.map(p => this.pairKey(p));
    const needsReorder = domOrder.length !== sortedOrder.length ||
                         domOrder.some((key, idx) => key !== sortedOrder[idx]);
    if (needsReorder) {
      for (const pair of sorted) {
        const pill = content.querySelector('[data-pair-key="' + this.pairKey(pair) + '"]');
        if (pill) content.appendChild(pill);
      }
    }
  }

  // Stable DOM key for a pill — issue number when issue-backed, or "pr-<n>"
  // for an orphan PR (a PR not connected to any issue).
  pairKey(pair) {
    return pair.issue ? String(pair.issue.number) : 'pr-' + pair.pr.number;
  }

  createPill(pair) {
    const color = this.resolvePillColor(pair.issue ? pair.issue.number : null);
    const pill = document.createElement('div');
    pill.className = 'lifecycle-pill';
    pill.dataset.pairKey = this.pairKey(pair);
    pill.style.setProperty('--pill-color', color.hex);
    pill.style.setProperty('--pill-rgb', color.rgb);
    pill.style.setProperty('--pill-glow', \`rgba(\${color.rgb},0.3)\`);
    pill.innerHTML = this.pillHTML(pair);
    return pill;
  }

  updatePill(pill, pair) {
    const color = this.resolvePillColor(pair.issue ? pair.issue.number : null);
    pill.style.setProperty('--pill-color', color.hex);
    pill.style.setProperty('--pill-rgb', color.rgb);
    pill.style.setProperty('--pill-glow', \`rgba(\${color.rgb},0.3)\`);

    const prHalf = pill.querySelector('.pill-pr-half');
    if (prHalf) {
      const isBlocked = pair.blockedByIssueNumbers && pair.blockedByIssueNumbers.length > 0;
      const newClass = \`pill-pr-half \${pair.prPhase}\${isBlocked ? ' blocked' : ''}\${pair.disabled ? ' disabled' : ''}\`;
      if (prHalf.className !== newClass) prHalf.className = newClass;
      const newContent = this.prHalfContent(pair);
      if (prHalf.innerHTML !== newContent) prHalf.innerHTML = newContent;
    }

    const issueHalf = pill.querySelector('.pill-issue-half');
    if (issueHalf) {
      const badgeEl = issueHalf.querySelector('.pill-badge');
      if (badgeEl) {
        const newBadge = pair.issue.state.toUpperCase();
        if (badgeEl.textContent !== newBadge) badgeEl.textContent = newBadge;
      }
      const titleEl = issueHalf.querySelector('.pill-title');
      if (titleEl) {
        if (titleEl.textContent !== pair.issue.title) titleEl.textContent = pair.issue.title;
      }
    }
  }

  pillHTML(pair) {
    const isBlocked = pair.blockedByIssueNumbers && pair.blockedByIssueNumbers.length > 0;
    const prHalf = \`<div class="pill-pr-half \${pair.prPhase}\${isBlocked ? ' blocked' : ''}\${pair.disabled ? ' disabled' : ''}">\${this.prHalfContent(pair)}</div>\`;
    // Orphan PR (not connected to an issue) — whole pill, empty left half.
    if (!pair.issue) {
      return \`<div class="pill-issue-half empty"></div>\${prHalf}\`;
    }
    const issueUrl = GITHUB_BASE_URL + '/issues/' + pair.issue.number;
    return \`
      <div class="pill-issue-half">
        <div class="pill-label">Issue</div>
        <div class="pill-row">
          <span class="pill-number"><a class="gh-link" href="\${issueUrl}" target="_blank" rel="noopener noreferrer">#\${pair.issue.number}</a></span>
          <span class="pill-badge">\${pair.issue.state.toUpperCase()}</span>
          <span class="pill-title">\${this.esc(pair.issue.title)}</span>
        </div>
      </div>
      \${prHalf}
    \`;
  }

  prHalfContent(pair) {
    if (!pair.pr) {
      if (pair.prPhase === 'planning') {
        return \`<div class="pill-label">PR</div><div class="pill-row"><span class="pill-title">implementing…</span></div>\`;
      }
      if (pair.prPhase === 'inactive' && pair.projectStatus) {
        return \`<div class="pill-label">Status</div><div class="pill-row"><span class="pill-badge pill-badge-inactive">\${this.esc(pair.projectStatus)}</span></div>\`;
      }
      if (pair.blockedByIssueNumbers && pair.blockedByIssueNumbers.length > 0) {
        const blockerBadges = pair.blockedByIssueNumbers
          .map(n => \`<span class="pill-badge pill-badge-blocked"><a class="gh-link" href="\${GITHUB_BASE_URL}/issues/\${n}" target="_blank" rel="noopener noreferrer">#\${n}</a></span>\`)
          .join('');
        return \`<div class="pill-label">Blocked by</div><div class="pill-row">\${blockerBadges}</div>\`;
      }
      return \`<div class="pill-label">PR</div><div class="pill-row"><span class="pill-title">—</span></div>\`;
    }
    const prUrl = GITHUB_BASE_URL + '/pull/' + pair.pr.number;
    const badges = [];
    if (pair.disabled) badges.push('MANUAL');
    if (pair.pr.draft) badges.push('DRAFT');
    if (pair.prPhase === 'review') badges.push('READY');
    if (pair.prPhase === 'completed') badges.push('MERGED');
    const checksIcon = pair.pr.checksStatus === 'success' ? '✓' :
                       pair.pr.checksStatus === 'failure' ? '✗' :
                       pair.pr.checksStatus === 'pending' ? '…' : '';
    if (checksIcon) badges.push(checksIcon);
    const badgeHTML = badges.map(b => \`<span class="pill-badge">\${b}</span>\`).join('');
    return \`
      <div class="pill-label">PR</div>
      <div class="pill-row">
        <span class="pill-number"><a class="gh-link" href="\${prUrl}" target="_blank" rel="noopener noreferrer">#\${pair.pr.number}</a></span>
        \${badgeHTML}
        <span class="pill-title">\${this.esc(pair.pr.title)}</span>
      </div>
    \`;
  }

  resolvePillColor(issueNumber) {
    const cylIdx = this.cylinderByIssue.get(issueNumber);
    if (cylIdx !== undefined) {
      return {
        hex: CYLINDER_COLORS[cylIdx % CYLINDER_COLORS.length],
        rgb: CYLINDER_COLORS_RGB[cylIdx % CYLINDER_COLORS_RGB.length],
      };
    }
    return { hex: '#555577', rgb: '85,85,119' };
  }

  recolorAllPills() {
    const content = document.getElementById('lifecycle-content');
    if (!content) {
      this.updateLifecycleSubtitle();
      return;
    }
    for (const pill of content.querySelectorAll('.lifecycle-pill')) {
      // Orphan-PR pills key as "pr-<n>" — non-numeric, so they keep their
      // default colour and are skipped by the isNaN guard below.
      const issueNumber = parseInt(pill.dataset.pairKey, 10);
      if (isNaN(issueNumber)) continue;
      const color = this.resolvePillColor(issueNumber);
      pill.style.setProperty('--pill-color', color.hex);
      pill.style.setProperty('--pill-rgb', color.rgb);
      pill.style.setProperty('--pill-glow', \`rgba(\${color.rgb},0.3)\`);
    }

    this.updateLifecycleSubtitle();
  }

  esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  updateConnectionStatus(connected) {
    if (this.appShutdown) return;
    const statusEl = document.getElementById('connection-status');
    const textEl   = document.getElementById('connection-text');
    if (!statusEl || !textEl) return;
    if (connected) {
      statusEl.classList.remove('disconnected');
      textEl.textContent = '🟢 Connected';
    } else {
      statusEl.classList.add('disconnected');
      textEl.textContent = '🔴 Disconnected';
    }
  }

}

const dashboard = new DashboardUI();
`;
  }

  private startCssWatch(): void {
    const cssDir = path.dirname(STATIC_BUNDLE_CSS);
    const cssFile = path.basename(STATIC_BUNDLE_CSS);
    try {
      this.cssWatcher = fs.watch(cssDir, (_eventType, filename) => {
        if (filename !== cssFile) return;
        if (this.cssReloadDebounce !== null) clearTimeout(this.cssReloadDebounce);
        this.cssReloadDebounce = setTimeout(() => {
          this.cssReloadDebounce = null;
          this.broadcastCssReload();
        }, 50);
      });
    } catch {
      // dist/dashboard not yet created; CSS hot reload disabled until first build
    }
  }

  private broadcastCssReload(): void {
    const message = JSON.stringify({ type: "css-reload", timestamp: new Date().toISOString(), data: {} });
    for (const client of this.wss.clients) {
      if (client.readyState === 1) client.send(message);
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", (error: NodeJS.ErrnoException) => {
        reject(error);
      });
      this.server.listen(this.port, this.host, () => {
        const url = `http://${this.host}:${this.port}`;
        console.log(`[Dashboard] Server listening at ${url}`);
        this.startCssWatch();
        resolve();
      });
    });
  }

  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async openBrowser(): Promise<void> {
    const url = this.getUrl();
    console.log(`[Dashboard] Opening browser at ${url}`);
    try {
      await open(url);
    } catch (error) {
      console.warn(`[Dashboard] Could not auto-open browser:`, error instanceof Error ? error.message : error);
    }
  }

  close(): void {
    this.unsubscribeFromEvents();
    if (this.cssReloadDebounce !== null) {
      clearTimeout(this.cssReloadDebounce);
      this.cssReloadDebounce = null;
    }
    this.cssWatcher?.close();
    this.cssWatcher = null;
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    this.server.close();
  }
}
