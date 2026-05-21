import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import open from "open";
import { globalEventEmitter, type DashboardEvent } from "./event-emitter.js";

interface DashboardServerConfig {
  port: number;
  host?: string;
  owner: string;
  repo: string;
  dashboardTitle?: string;
}

let APP_VERSION = "unknown";
try {
  const pkgText = fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8");
  APP_VERSION = (JSON.parse(pkgText) as { version: string }).version;
} catch { /* ignore */ }

const ROOT_DIR = process.cwd();
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

  constructor(config: DashboardServerConfig) {
    this.port = config.port;
    this.host = config.host ?? "localhost";
    this.owner = config.owner;
    this.repo = config.repo;
    this.dashboardTitle = config.dashboardTitle ?? "Vibrator";

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

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

    globalEventEmitter.subscribe((event) => {
      this.broadcastEvent(event);
    });
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

    ws.on("message", () => {
      // Ignore inbound frames; protocol may grow later
    });

    ws.on("close", () => {
      // Connection closed
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
    } else if (type === "shutdown-requested" || type === "app-shutdown") {
      this.cachedEvents.set(type, event);
    }
  }

  private broadcastEvent(event: DashboardEvent): void {
    this.updateStateCache(event);
    const message = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }

  async initialize(): Promise<void> {
    // No-op: static files are served from src/dashboard/ via serveStatic()
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", (error: NodeJS.ErrnoException) => {
        reject(error);
      });
      this.server.listen(this.port, this.host, () => {
        const url = `http://${this.host}:${this.port}`;
        console.log(`[Dashboard] Server listening at ${url}`);
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
    this.wss.close();
    this.server.close();
  }
}
