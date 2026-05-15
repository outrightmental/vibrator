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

.iteration-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}

.iteration-label {
  font-size: 12px;
  color: #ff00ff;
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 5px rgba(255, 0, 255, 0.5);
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

/* ── Panel B: Issue → PR Lifecycle ─────────────────────────────────────── */

.lifecycle-section {
  padding: 12px 30px;
  border-bottom: 1px solid rgba(0, 255, 136, 0.25);
  background: rgba(5, 8, 20, 0.7);
  flex-shrink: 0;
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
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 52px;
  align-items: flex-start;
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
  min-width: 380px;
  flex: 1;
  max-width: 600px;
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

/* absent: ghost right half, full border separates the two halves */
.pill-pr-half.absent {
  border: 2px dashed rgba(128, 128, 128, 0.2);
  opacity: 0.35;
}

/* planning: colored dashed border, pulsing */
.pill-pr-half.planning {
  border: 2px dashed var(--pill-color);
  background: transparent;
  animation: planningPulse 1.8s ease-in-out infinite;
}

@keyframes planningPulse {
  0%, 100% { opacity: 0.5; }
  50%       { opacity: 1; }
}

/* active: solid border, subtle fill */
.pill-pr-half.active {
  border: 2px solid var(--pill-color);
  border-left: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(var(--pill-rgb), 0.14);
}

/* completed: solid fill — satisfying final state */
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

/* ── End Panel B ─────────────────────────────────────────────────────── */

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

.cycle-banner {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1000;
  background: rgba(10, 14, 39, 0.95);
  border: 3px solid #ff00ff;
  padding: 40px 60px;
  text-align: center;
  border-radius: 8px;
  box-shadow: 0 0 40px rgba(255, 0, 255, 0.6), inset 0 0 40px rgba(255, 0, 255, 0.1);
  animation: bannerPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.cycle-banner-text {
  font-size: 36px;
  font-weight: 700;
  color: #ff00ff;
  text-shadow: 0 0 20px rgba(255, 0, 255, 1);
  margin: 0;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.cycle-banner-subtext {
  font-size: 18px;
  color: #00ff88;
  margin-top: 15px;
  text-shadow: 0 0 10px rgba(0, 255, 136, 0.8);
}

@keyframes bannerPop {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.5);
  }
  70% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.1);
  }
  100% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

@keyframes bannerFadeOut {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.cycle-banner.fade-out {
  animation: bannerFadeOut 0.8s ease-out forwards;
}
`;
  }

  private generateJS(): string {
    return `
// Palette of 6 distinct neon colours used to colour-coordinate pills with
// worker threads. Colour slot = issueNumber % PILL_PALETTE.length, which
// keeps the assignment stable for the lifetime of the SDLC cycle.
const PILL_PALETTE = [
  { hex: '#00ff88', rgb: '0,255,136' },   // green
  { hex: '#ff00ff', rgb: '255,0,255' },   // magenta
  { hex: '#0088ff', rgb: '0,136,255' },   // blue
  { hex: '#ffff00', rgb: '255,255,0' },   // yellow
  { hex: '#ff6600', rgb: '255,102,0' },   // orange
  { hex: '#aa00ff', rgb: '170,0,255' },   // purple
];

class DashboardUI {
  constructor() {
    this.appContainer = document.getElementById('app');
    this.events = [];
    this.phases = ['implementation', 'review'];
    this.currentPhase = null;
    this.countdownInterval = null;
    this.nextCycleTime = null;
    this.connected = false;
    this.iterationNumber = 0;
    this.lastIterationStartTime = null;
    this.bannerTimeout = null;
    this.init();
  }

  init() {
    this.render();
    this.connectWebSocket();
    this.startCountdown();
  }

  render() {
    this.appContainer.innerHTML = \`
      <div class="cycle-banner hidden" id="cycle-banner">
        <div class="cycle-banner-text">⚡ CYCLE START</div>
        <div class="cycle-banner-subtext" id="banner-iteration">Iteration --</div>
      </div>
      <div class="header">
        <div>
          <div class="header-title">⚡ VIBRATOR</div>
          <div class="header-repo">AI SDLC Dashboard</div>
        </div>
        <div class="iteration-info">
          <div class="iteration-label">Iteration</div>
          <div class="iteration-number" id="iteration-number">--</div>
        </div>
        <div class="countdown">
          <div class="countdown-label">Next Cycle In</div>
          <div class="countdown-timer" id="countdown-timer">--:--</div>
        </div>
      </div>
      <div class="lifecycle-section">
        <div class="lifecycle-header">
          <div class="lifecycle-title">Panel B — Issue → PR Lifecycle</div>
          <div class="lifecycle-subtitle" id="lifecycle-subtitle">waiting for snapshot…</div>
        </div>
        <div id="lifecycle-content" class="lifecycle-content">
          <div class="lifecycle-empty">Connecting to vibrator…</div>
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
    if (this.events.length > 1000) {
      this.events.shift();
    }
    document.getElementById('event-count').textContent = this.events.length;

    // Update session count if present in message data
    if (message.data && typeof message.data.sessionCount === 'number') {
      document.getElementById('session-count').textContent = message.data.sessionCount;
    }

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
      case 'action-error':
        this.handleActionError(message);
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
      default:
        this.addLogLine('info', \`[EVENT] \${message.type}: \${JSON.stringify(message.data)}\`);
    }
  }

  handleIterationStart(message) {
    this.iterationNumber = message.data.iterationNumber;
    this.lastIterationStartTime = new Date(message.timestamp);
    document.getElementById('iteration-number').textContent = this.iterationNumber;
    document.getElementById('banner-iteration').textContent = \`Iteration \${this.iterationNumber}\`;
    this.showCycleBanner();
    this.addLogLine('info', \`🔄 Iteration \${message.data.iterationNumber} started\`);
    this.currentPhase = null;
  }

  showCycleBanner() {
    const banner = document.getElementById('cycle-banner');
    if (!banner) return;

    if (this.bannerTimeout) clearTimeout(this.bannerTimeout);

    banner.classList.remove('hidden', 'fade-out');
    void banner.offsetWidth;

    this.bannerTimeout = setTimeout(() => {
      banner.classList.add('fade-out');
      setTimeout(() => {
        banner.classList.add('hidden');
      }, 800);
    }, 3000);
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
    this.addLogLine('success', \`✓ Action complete [\${message.data.actionIndex}/\${message.data.totalActions}]\`);
  }

  handleActionError(message) {
    this.addLogLine('error', \`✗ Action failed [\${message.data.actionIndex}/\${message.data.totalActions}]: \${message.data.error}\`);
  }

  handleWorkflowApproval(message) {
    const runName = message.data.runName || 'unknown';
    this.addLogLine('success', \`✓ Workflow approved: \${runName}\`);
    this.addBroadcastTicker('ci', \`Workflow \${runName} approved and queued for execution\`);
  }

  handleBroadcastEvent(message) {
    const eventType = message.type.replace('broadcast-', '').toUpperCase();
    const content = message.data.content || JSON.stringify(message.data);
    const category = message.type === 'broadcast-ci-status' ? 'ci' :
                    message.type === 'broadcast-commit' ? 'commit' :
                    message.type === 'broadcast-pr-update' ? 'pr' : 'info';
    this.addBroadcastTicker(category, \`[\${eventType}] \${content}\`);
  }

  handleLogMessage(message) {
    const level = message.data.level || 'info';
    this.addLogLine(level, message.data.message || '');
  }

  handleSnapshotUpdate(message) {
    const data = message.data;
    document.getElementById('session-count').textContent = data.sessionCount || 0;
  }

  handleCycleCountdown(message) {
    if (message.data.nextCycleTime) {
      this.nextCycleTime = new Date(message.data.nextCycleTime).getTime();
    } else {
      this.nextCycleTime = new Date(message.timestamp).getTime() + (message.data.msUntilCycle || 0);
    }
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

    const label = document.createElement('div');
    label.className = 'broadcast-ticker-label';
    label.textContent = '📡 BROADCAST';

    const content = document.createElement('div');
    content.className = 'broadcast-ticker-content';
    content.textContent = text;

    ticker.appendChild(label);
    ticker.appendChild(content);
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

  handleLifecycleUpdate(message) {
    const pairs = message.data.pairs;
    if (!Array.isArray(pairs)) return;

    const content = document.getElementById('lifecycle-content');
    const subtitle = document.getElementById('lifecycle-subtitle');
    if (!content) return;

    if (pairs.length === 0) {
      content.innerHTML = '<div class="lifecycle-empty">⚡ All issues complete — repository is clean</div>';
      if (subtitle) subtitle.textContent = 'done';
      return;
    }

    if (subtitle) {
      const active = pairs.filter(p => p.prPhase === 'active' || p.prPhase === 'planning').length;
      const done   = pairs.filter(p => p.prPhase === 'completed').length;
      subtitle.textContent = \`\${pairs.length} item\${pairs.length !== 1 ? 's' : ''} · \${active} in progress · \${done} completed\`;
    }

    // Re-render all pills (keyed by issue number via data attribute)
    const existingKeys = new Set(
      [...content.querySelectorAll('.lifecycle-pill')].map(el => el.dataset.issueNumber)
    );
    const incomingKeys = new Set(pairs.map(p => String(p.issue.number)));

    // Remove pills that no longer exist
    for (const key of existingKeys) {
      if (!incomingKeys.has(key)) {
        content.querySelector(\`[data-issue-number="\${key}"]\`)?.remove();
      }
    }

    for (const pair of pairs) {
      const key = String(pair.issue.number);
      let pill = content.querySelector(\`[data-issue-number="\${key}"]\`);

      if (!pill) {
        pill = this.createPill(pair);
        const allExisting = [...content.querySelectorAll('.lifecycle-pill')];
        const anchor = allExisting.find(el => parseInt(el.dataset.issueNumber, 10) > pair.issue.number);
        if (anchor) {
          content.insertBefore(pill, anchor);
        } else {
          content.appendChild(pill);
        }
      } else {
        this.updatePill(pill, pair);
      }
    }
  }

  createPill(pair) {
    const color = PILL_PALETTE[pair.colorIndex % PILL_PALETTE.length];
    const pill = document.createElement('div');
    pill.className = 'lifecycle-pill';
    pill.dataset.issueNumber = String(pair.issue.number);
    pill.style.setProperty('--pill-color', color.hex);
    pill.style.setProperty('--pill-rgb', color.rgb);
    pill.style.setProperty('--pill-glow', \`rgba(\${color.rgb},0.3)\`);
    pill.innerHTML = this.pillHTML(pair);
    return pill;
  }

  updatePill(pill, pair) {
    const color = PILL_PALETTE[pair.colorIndex % PILL_PALETTE.length];
    pill.style.setProperty('--pill-color', color.hex);
    pill.style.setProperty('--pill-rgb', color.rgb);
    pill.style.setProperty('--pill-glow', \`rgba(\${color.rgb},0.3)\`);

    const prHalf = pill.querySelector('.pill-pr-half');
    if (prHalf) {
      // Update only the PR half class/content so the pill doesn't flicker
      prHalf.className = \`pill-pr-half \${pair.prPhase}\`;
      prHalf.innerHTML = this.prHalfContent(pair);
    }
  }

  pillHTML(pair) {
    return \`
      <div class="pill-issue-half">
        <div class="pill-label">Issue</div>
        <div class="pill-row">
          <span class="pill-number">#\${pair.issue.number}</span>
          <span class="pill-title">\${this.esc(pair.issue.title)}</span>
        </div>
      </div>
      <div class="pill-pr-half \${pair.prPhase}">\${this.prHalfContent(pair)}</div>
    \`;
  }

  prHalfContent(pair) {
    if (!pair.pr) {
      if (pair.prPhase === 'planning') {
        return \`<div class="pill-label">PR</div><div class="pill-row"><span class="pill-title">implementing…</span></div>\`;
      }
      return \`<div class="pill-label">PR</div><div class="pill-row"><span class="pill-title">—</span></div>\`;
    }
    const badges = [];
    if (pair.pr.draft) badges.push('DRAFT');
    if (pair.prPhase === 'completed') badges.push('MERGED');
    const checksIcon = pair.pr.checksStatus === 'success' ? '✓' :
                       pair.pr.checksStatus === 'failure' ? '✗' :
                       pair.pr.checksStatus === 'pending' ? '…' : '';
    if (checksIcon) badges.push(checksIcon);
    const badgeHTML = badges.map(b => \`<span class="pill-badge">\${b}</span>\`).join('');
    return \`
      <div class="pill-label">PR</div>
      <div class="pill-row">
        <span class="pill-number">#\${pair.pr.number}</span>
        \${badgeHTML}
        <span class="pill-title">\${this.esc(pair.pr.title)}</span>
      </div>
    \`;
  }

  esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
    return new Promise((resolve, reject) => {
      this.server.on("error", (error: NodeJS.ErrnoException) => {
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
