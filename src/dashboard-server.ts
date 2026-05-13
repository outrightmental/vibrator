import * as http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import open from "open";
import { globalEventEmitter, type DashboardEvent } from "./event-emitter.js";

interface DashboardServerConfig {
  port: number;
  host?: string;
}

export class DashboardServer {
  private port: number;
  private host: string;
  private server: http.Server;
  private wss: WebSocketServer;
  private htmlContent: string = "";

  constructor(config: DashboardServerConfig) {
    this.port = config.port;
    this.host = config.host ?? "localhost";

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on("connection", (ws) => this.handleWebSocketConnection(ws));

    // Subscribe to global events and broadcast to all connected clients
    globalEventEmitter.subscribe((event) => {
      this.broadcastEvent(event);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Serve static files or root HTML
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(this.htmlContent);
      return;
    }

    // 404 for other paths
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  private handleWebSocketConnection(ws: WebSocket): void {
    // Send initial state
    ws.send(
      JSON.stringify({
        type: "connection",
        message: "Connected to vibrator dashboard",
      }),
    );

    ws.on("error", (error: Error) => {
      console.error("[Dashboard] WebSocket error:", error);
    });

    ws.on("close", () => {
      // Connection closed
    });
  }

  private broadcastEvent(event: DashboardEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        // OPEN state
        client.send(message);
      }
    }
  }

  async initialize(): Promise<void> {
    this.htmlContent = await this.generateHTML();
  }

  private async generateHTML(): Promise<string> {
    const css = await this.generateCSS();
    const js = this.generateJS();

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
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');

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
  background:
    repeating-linear-gradient(
      0deg,
      rgba(0, 255, 136, 0.03) 0px,
      rgba(0, 255, 136, 0.03) 1px,
      transparent 1px,
      transparent 2px
    ),
    repeating-linear-gradient(
      90deg,
      rgba(0, 255, 136, 0.03) 0px,
      rgba(0, 255, 136, 0.03) 1px,
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

.header {
  padding: 20px 30px;
  border-bottom: 2px solid #00ff88;
  box-shadow: 0 0 20px rgba(0, 255, 136, 0.3);
  background: rgba(10, 14, 39, 0.9);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 20px;
  z-index: 10;
}

.header-title {
  font-size: 28px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 3px;
  color: #00ff88;
  text-shadow: 0 0 10px rgba(0, 255, 136, 0.8);
}

.header-repo {
  font-size: 14px;
  color: #ff00ff;
  text-shadow: 0 0 5px rgba(255, 0, 255, 0.5);
}

.countdown {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}

.countdown-label {
  font-size: 12px;
  color: #0088ff;
  text-transform: uppercase;
  letter-spacing: 2px;
}

.countdown-timer {
  font-size: 24px;
  font-weight: 700;
  color: #00ff88;
  text-shadow: 0 0 15px rgba(0, 255, 136, 1);
  font-variant-numeric: tabular-nums;
}

.main-content {
  flex: 1;
  display: flex;
  gap: 20px;
  padding: 20px 30px;
  overflow: hidden;
}

.phase-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: rgba(20, 10, 50, 0.6);
  border: 2px solid #00ff88;
  border-radius: 4px;
  padding: 20px;
  box-shadow: 0 0 20px rgba(0, 255, 136, 0.2), inset 0 0 20px rgba(0, 255, 136, 0.05);
  overflow: hidden;
}

.phase-section.active {
  border-color: #ffff00;
  box-shadow: 0 0 30px rgba(255, 255, 0, 0.4), inset 0 0 20px rgba(255, 255, 0, 0.1);
  animation: pulse-glow 1s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 30px rgba(255, 255, 0, 0.4), inset 0 0 20px rgba(255, 255, 0, 0.1); }
  50% { box-shadow: 0 0 50px rgba(255, 255, 0, 0.6), inset 0 0 30px rgba(255, 255, 0, 0.15); }
}

.phase-title {
  font-size: 16px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: #00ff88;
  margin-bottom: 15px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(0, 255, 136, 0.3);
}

.phase-section.active .phase-title {
  color: #ffff00;
  text-shadow: 0 0 10px rgba(255, 255, 0, 1);
}

.phase-content {
  flex: 1;
  overflow-y: auto;
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

.broadcast-ticker {
  padding: 10px;
  background: rgba(255, 0, 255, 0.1);
  border-left: 3px solid #ff00ff;
  margin: 10px 0;
  border-radius: 2px;
  animation: slideIn 0.5s ease-out;
}

@keyframes slideIn {
  from { transform: translateX(-20px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.broadcast-ticker.commit {
  border-left-color: #00ff88;
  background: rgba(0, 255, 136, 0.1);
  color: #00ff88;
}

.broadcast-ticker.pr {
  border-left-color: #0088ff;
  background: rgba(0, 136, 255, 0.1);
  color: #0088ff;
}

.broadcast-ticker.ci {
  border-left-color: #ffff00;
  background: rgba(255, 255, 0, 0.1);
  color: #ffff00;
}

.broadcast-ticker-label {
  font-weight: 700;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 3px;
}

.broadcast-ticker-content {
  font-size: 12px;
  word-break: break-word;
}

.status-bar {
  padding: 15px 30px;
  border-top: 2px solid #00ff88;
  background: rgba(10, 14, 39, 0.9);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  z-index: 10;
  font-size: 12px;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #00ff88;
  box-shadow: 0 0 5px rgba(0, 255, 136, 0.8);
}

.status-indicator.active {
  animation: blink 1s ease-in-out infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.connection-status {
  padding: 5px 10px;
  border-radius: 2px;
  background: rgba(0, 255, 136, 0.2);
  border: 1px solid #00ff88;
}

.connection-status.disconnected {
  background: rgba(255, 0, 0, 0.2);
  border-color: #ff0055;
  color: #ff0055;
}

.stats {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}

.stat {
  display: flex;
  gap: 8px;
}

.stat-value {
  font-weight: 700;
  color: #ffff00;
}

.hidden {
  display: none !important;
}
`;
  }

  private generateJS(): string {
    return `
class DashboardUI {
  constructor() {
    this.appContainer = document.getElementById('app');
    this.events = [];
    this.phases = ['implementation', 'self-review', 'address-failing-checks', 'resolve-conflicts', 'squash-merge'];
    this.currentPhase = null;
    this.countdownInterval = null;
    this.nextCycleTime = null;
    this.connected = false;
    this.init();
  }

  init() {
    this.render();
    this.connectWebSocket();
    this.startCountdown();
  }

  render() {
    this.appContainer.innerHTML = \`
      <div class="header">
        <div>
          <div class="header-title">⚡ VIBRATOR</div>
          <div class="header-repo">AI SDLC BROADCAST</div>
        </div>
        <div class="countdown">
          <div class="countdown-label">Next Cycle In</div>
          <div class="countdown-timer" id="countdown-timer">--:--</div>
        </div>
      </div>
      <div class="main-content">
        <div class="phase-section active" id="phase-implementation">
          <div class="phase-title">⚙ Implementation</div>
          <div class="phase-content" id="phase-implementation-content"></div>
        </div>
        <div class="phase-section" id="phase-review">
          <div class="phase-title">👁 Review</div>
          <div class="phase-content" id="phase-review-content"></div>
        </div>
        <div class="phase-section" id="phase-broadcast">
          <div class="phase-title">📡 Broadcast Feed</div>
          <div class="phase-content" id="phase-broadcast-content"></div>
        </div>
      </div>
      <div class="status-bar">
        <div class="status-item">
          <div class="status-indicator active"></div>
          <span>Vibrator Active</span>
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
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

    ws.onopen = () => {
      this.connected = true;
      this.updateConnectionStatus(true);
      console.log('Connected to vibrator dashboard');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.updateConnectionStatus(false);
    };

    ws.onclose = () => {
      this.connected = false;
      this.updateConnectionStatus(false);
      setTimeout(() => this.connectWebSocket(), 3000);
    };
  }

  handleMessage(message) {
    if (!message.type) return;

    this.events.push(message);
    document.getElementById('event-count').textContent = this.events.length;

    switch (message.type) {
      case 'iteration-start':
        this.handleIterationStart(message);
        break;
      case 'phase-update':
        this.handlePhaseUpdate(message);
        break;
      case 'action-start':
        this.handleActionStart(message);
        break;
      case 'action-complete':
        this.handleActionComplete(message);
        break;
      case 'workflow-approval':
        this.handleWorkflowApproval(message);
        break;
      case 'snapshot-update':
        this.handleSnapshotUpdate(message);
        break;
      case 'cycle-countdown':
        this.handleCycleCountdown(message);
        break;
      default:
        this.addLogLine('info', \`[EVENT] \${message.type}: \${JSON.stringify(message.data)}\`);
    }
  }

  handleIterationStart(message) {
    this.addLogLine('info', \`🔄 Iteration \${message.data.iterationNumber} started\`);
    this.currentPhase = null;
  }

  handlePhaseUpdate(message) {
    const phase = message.data.phase;
    this.currentPhase = phase;
    this.updatePhaseUI(phase);
    this.addLogLine('info', \`📍 Phase: \${phase}\`);
  }

  handleActionStart(message) {
    const actionDesc = message.data.description || message.data.type;
    this.addLogLine('info', \`▶ Action: \${actionDesc}\`);
  }

  handleActionComplete(message) {
    this.addLogLine('success', \`✓ Action complete\`);
  }

  handleWorkflowApproval(message) {
    this.addLogLine('success', \`✓ Workflow approved: \${message.data.runId || 'unknown'}\`);
  }

  handleSnapshotUpdate(message) {
    const data = message.data;
    document.getElementById('session-count').textContent = data.sessionCount || 0;
    this.addBroadcastTicker(
      'info',
      \`Repository snapshot: \${data.issueCount || 0} issues, \${data.prCount || 0} PRs, \${data.sessionCount || 0} sessions\`
    );
  }

  handleCycleCountdown(message) {
    this.nextCycleTime = new Date(message.timestamp).getTime() + (message.data.msUntilCycle || 0);
  }

  updatePhaseUI(phase) {
    document.querySelectorAll('.phase-section').forEach(el => {
      el.classList.remove('active');
    });
    const activePhase = document.getElementById(\`phase-\${phase}\`);
    if (activePhase) {
      activePhase.classList.add('active');
    }
  }

  addLogLine(level, text) {
    const content = this.getCurrentPhaseContent();
    if (!content) return;

    const line = document.createElement('div');
    line.className = \`log-line \${level}\`;
    line.textContent = \`[\${new Date().toLocaleTimeString()}] \${text}\`;
    content.appendChild(line);
    content.scrollTop = content.scrollHeight;

    if (content.children.length > 100) {
      content.removeChild(content.firstChild);
    }
  }

  addBroadcastTicker(level, text) {
    const broadcastContent = document.getElementById('phase-broadcast-content');
    if (!broadcastContent) return;

    const ticker = document.createElement('div');
    ticker.className = \`broadcast-ticker \${level}\`;
    ticker.innerHTML = \`
      <div class="broadcast-ticker-label">📡 BROADCAST</div>
      <div class="broadcast-ticker-content">\${text}</div>
    \`;
    broadcastContent.appendChild(ticker);
    broadcastContent.scrollTop = broadcastContent.scrollHeight;

    if (broadcastContent.children.length > 50) {
      broadcastContent.removeChild(broadcastContent.firstChild);
    }
  }

  getCurrentPhaseContent() {
    const phase = this.currentPhase || 'implementation';
    return document.getElementById(\`phase-\${phase}-content\`);
  }

  updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    const textEl = document.getElementById('connection-text');
    if (connected) {
      statusEl.classList.remove('disconnected');
      textEl.textContent = '🟢 Connected';
    } else {
      statusEl.classList.add('disconnected');
      textEl.textContent = '🔴 Disconnected';
    }
  }

  startCountdown() {
    this.countdownInterval = setInterval(() => {
      if (!this.nextCycleTime) return;

      const now = new Date().getTime();
      const diff = this.nextCycleTime - now;

      if (diff <= 0) {
        document.getElementById('countdown-timer').textContent = '0:00';
        return;
      }

      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      document.getElementById('countdown-timer').textContent =
        \`\${minutes}:\${String(secs).padStart(2, '0')}\`;
    }, 100);
  }
}

const dashboard = new DashboardUI();
`;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
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
