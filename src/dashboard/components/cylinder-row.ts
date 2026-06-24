import { LitElement, html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { CylinderState } from '../store/types.js';
import { formatDuration, formatModelName } from '../shared/format.js';

export class CylinderRow extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .cylinder-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      height: 160px;
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

    .cylinder-row.done   { opacity: 0.65; }

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

    .cylinder-row.active .cylinder-dot { opacity: 1; }

    .cylinder-dot.pulsing { animation: cylPulse 1.2s ease-in-out infinite; }

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
      text-shadow: 0 0 5px var(--cyl-color, rgba(0,255,136,0.5));
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

    .cylinder-row.active .cylinder-status-text { color: rgba(255, 255, 255, 0.8); }

    .cylinder-thinking-stream {
      margin-top: 6px;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      font-size: 9px;
      font-family: monospace;
      color: rgba(0, 255, 136, 0.25);
      line-height: 1.4;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .cylinder-thinking-stream.active { color: rgba(0, 255, 136, 0.65); }

    .cylinder-thinking-stream::-webkit-scrollbar { width: 3px; }
    .cylinder-thinking-stream::-webkit-scrollbar-thumb {
      background: rgba(0, 255, 136, 0.3);
      border-radius: 2px;
    }

    a.gh-link { color: inherit; text-decoration: none; cursor: pointer; }
    a.gh-link:hover { text-decoration: underline; filter: brightness(1.4); }
  `;

  static override properties = {
    cylinder: { type: Object },
    owner: { type: String },
    repo: { type: String },
    tick: { type: Number },
  };

  cylinder: CylinderState | null = null;
  owner = '';
  repo = '';
  tick = 0;

  private _statusHtml(cyl: CylinderState): string {
    const baseUrl = `https://github.com/${this.owner}/${this.repo}`;
    const isActive   = cyl.status === 'active';
    const isDone     = cyl.status === 'done';
    const isError    = cyl.status === 'error';
    const isShutdown = cyl.status === 'shutdown';

    if (isShutdown) return '⏹ shutdown';

    if (isActive || isDone || isError) {
      const issueLink = cyl.issueNumber != null
        ? `<a class="gh-link" href="${baseUrl}/issues/${cyl.issueNumber}" target="_blank" rel="noopener noreferrer">#${cyl.issueNumber}</a>`
        : '';
      const prLink = cyl.prNumber != null
        ? `<a class="gh-link" href="${baseUrl}/pull/${cyl.prNumber}" target="_blank" rel="noopener noreferrer">PR #${cyl.prNumber}</a>`
        : '';

      let s: string;
      switch (cyl.actionType) {
        case 'start-implementation': s = `implementing ${issueLink}`; break;
        case 'self-review':          s = `reviewing ${prLink}`; break;
        case 'address-failing-checks': s = `fixing checks ${prLink}`; break;
        case 'squash-merge':         s = `merging ${prLink}`; break;
        case 'resolve-conflicts':    s = `resolving conflicts ${prLink}`; break;
        default: s = this._esc(cyl.actionType || 'working');
      }
      if (isDone)  s = `✓ ${s}`;
      if (isError) s = `✗ ${s}`;
      if (isActive && cyl.actionStartedAt) s += ` · ${formatDuration(Date.now() - cyl.actionStartedAt)}`;
      return s;
    }

    const now = Date.now();
    if (cyl.rateLimitedUntilMs && cyl.rateLimitedUntilMs > now) {
      return this._esc(`rate limited · ${formatDuration(cyl.rateLimitedUntilMs - now)}`);
    }
    if (cyl.nextCycleAtMs && cyl.nextCycleAtMs > now) {
      return this._esc(formatDuration(cyl.nextCycleAtMs - now));
    }
    return this._esc(cyl.idleStatusText || 'idle');
  }

  private _esc(text: string): string {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(text)));
    return d.innerHTML;
  }

  override render() {
    const cyl = this.cylinder;
    if (!cyl) return html``;

    const isActive = cyl.status === 'active';
    const isIdle = cyl.status === 'idle';
    const modelLabel = isIdle ? 'Idle' : (formatModelName(cyl.model) ?? `CYL ${cyl.index}`);
    const cycleLabel = cyl.iterationNumber > 0 ? ` #${cyl.iterationNumber}` : '';
    const hasThinking = isActive && cyl.thinkingLines.length > 0;
    const dotClass = `cylinder-dot${isActive ? ' pulsing' : ''}`;
    const thinkingClass = `cylinder-thinking-stream${hasThinking ? ' active' : ''}`;
    const rowClass = `cylinder-row ${cyl.status}`;

    return html`
      <div
        class="${rowClass}"
        style="--cyl-color:${cyl.color};--cyl-color-rgb:${cyl.colorRgb}"
      >
        <div class="${dotClass}"></div>
        <div class="cylinder-info">
          <div class="cylinder-label">${modelLabel}${cycleLabel}</div>
          <div class="cylinder-status-text">${unsafeHTML(this._statusHtml(cyl))}</div>
          <div class="${thinkingClass}">${cyl.thinkingLines.join('\n')}</div>
        </div>
        <div class="cylinder-spinner"></div>
      </div>
    `;
  }
}

customElements.define('cylinder-row', CylinderRow);
