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
    this.broadcastQueue = [];
    this.broadcastProcessing = false;
    this.BROADCAST_FANFARE_MS = 3000;
    this.BROADCAST_MAX_ITEMS = 15;
    this.workerColors = ['#00ff88', '#ff00ff', '#0088ff', '#ffff00', '#ff8800'];
    this.workerMap = {};
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
          <div class="header-repo">AI SDLC BROADCAST</div>
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
    const workerIndex = (message.data.actionIndex || 1) - 1;

    const prMatch = (actionDesc || '').match(/PR #(\d+)/);
    const issueMatch = (actionDesc || '').match(/issue #(\d+)/i);
    if (prMatch) this.workerMap['pr:' + prMatch[1]] = workerIndex;
    if (issueMatch) this.workerMap['issue:' + issueMatch[1]] = workerIndex;

    const color = this.getWorkerColor(null, workerIndex);
    const content = this.getCurrentPhaseContent();
    if (!content) return;
    const line = document.createElement('div');
    line.className = 'log-line info';
    line.style.cssText = 'border-left: 2px solid ' + color + '; padding-left: 6px;';
    line.innerHTML = '<span style="color:' + color + '; margin-right:4px;">●</span>'
      + '<span style="color:rgba(255,255,255,0.5);">[' + new Date().toLocaleTimeString() + ']</span> '
      + this.escapeHtml('▶ [' + message.data.actionIndex + '/' + message.data.totalActions + '] ' + actionDesc);
    content.appendChild(line);
    content.scrollTop = content.scrollHeight;
    if (content.children.length > 100) content.removeChild(content.firstChild);
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
    this.enqueueBroadcastEvent({
      category: 'ci',
      label: 'WORKFLOW',
      stateBefore: 'Workflow "' + runName + '" was awaiting approval',
      changeHow: 'Vibrator automatically approved the workflow run',
      stateAfter: '✅ Workflow "' + runName + '" approved and queued',
      excellence: 'CI pipeline unblocked — automated approval keeps development flowing',
      workerIndex: undefined,
    });
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
    });
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

  enqueueBroadcastEvent(eventData) {
    this.broadcastQueue.push(eventData);
    if (!this.broadcastProcessing) {
      this.processNextBroadcastEvent();
    }
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
    const categoryColors = { commit: '#00ff88', pr: '#0088ff', ci: '#ffff00', issue: '#ff8800' };
    return (category && categoryColors[category]) || '#ff00ff';
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(text)));
    return div.innerHTML;
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

    const card = document.createElement('div');
    card.className = 'broadcast-event';
    card.style.cssText = 'border-left-color:' + color + ';background:rgba(' + r + ',' + g + ',' + b + ',0.07);';

    const nowTagStyle = 'background:' + color + ';';
    const dotStyle = 'background:' + color + ';box-shadow:0 0 6px ' + color + ';';
    const typeStyle = 'color:' + color + ';';

    const excellenceHtml = excellence
      ? '<div class="broadcast-event-excellence">✨ ' + this.escapeHtml(excellence) + '</div>'
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
      + '<span>' + this.escapeHtml(stateBefore || '') + '</span>'
      + '</div>'
      + '<div class="broadcast-event-row how-row">'
      + '<span class="broadcast-event-tag">HOW</span>'
      + '<span>' + this.escapeHtml(changeHow || '') + '</span>'
      + '</div>'
      + '<div class="broadcast-event-row after-row">'
      + '<span class="broadcast-event-tag" style="' + nowTagStyle + '">NOW</span>'
      + '<span>' + this.escapeHtml(stateAfter || '') + '</span>'
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
