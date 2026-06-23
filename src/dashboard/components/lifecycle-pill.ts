import { LitElement, html, css } from 'lit';
import type { LifecyclePair } from '../store/types.js';

export class LifecyclePill extends LitElement {
  static override styles = css`
    :host { display: block; }

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

    .pill-pr-half.review {
      border: 2px solid var(--pill-color);
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(var(--pill-rgb), 0.25);
      box-shadow: 0 0 10px rgba(var(--pill-rgb), 0.35);
    }

    .pill-pr-half.active {
      border: 2px solid var(--pill-color);
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(var(--pill-rgb), 0.14);
    }

    .pill-pr-half.inactive {
      border: 2px dashed rgba(120, 120, 135, 0.4);
      opacity: 0.55;
    }

    .pill-pr-half.completed {
      border: 2px solid var(--pill-color);
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(var(--pill-rgb), 0.38);
      box-shadow: inset 0 0 14px rgba(var(--pill-rgb), 0.2);
    }

    .pill-pr-half.disabled {
      border: 2px dashed rgba(150, 150, 160, 0.4);
      background: rgba(150, 150, 160, 0.06);
      box-shadow: none;
      opacity: 0.45;
      filter: grayscale(1);
      animation: none;
    }

    .pill-pr-half.absent.blocked {
      border: 2px dashed rgba(255, 100, 80, 0.35);
      opacity: 0.75;
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

    a.gh-link { color: inherit; text-decoration: none; cursor: pointer; }
    a.gh-link:hover { text-decoration: underline; filter: brightness(1.4); }
  `;

  static override properties = {
    pair: { type: Object },
    color: { type: String },
    colorRgb: { type: String },
    owner: { type: String },
    repo: { type: String },
  };

  pair: LifecyclePair | null = null;
  color = '#555577';
  colorRgb = '85,85,119';
  owner = '';
  repo = '';

  private _prHalf() {
    const pair = this.pair!;
    const baseUrl = `https://github.com/${this.owner}/${this.repo}`;
    const isBlocked = (pair.blockedByIssueNumbers?.length ?? 0) > 0;
    const prClass = `pill-pr-half ${pair.prPhase ?? 'absent'}${isBlocked ? ' blocked' : ''}${pair.disabled ? ' disabled' : ''}`;

    if (!pair.pr) {
      if (pair.prPhase === 'planning') {
        return html`
          <div class="${prClass}">
            <div class="pill-label">PR</div>
            <div class="pill-row"><span class="pill-title">implementing…</span></div>
          </div>`;
      }
      if (pair.prPhase === 'inactive' && pair.projectStatus) {
        return html`
          <div class="${prClass}">
            <div class="pill-label">Status</div>
            <div class="pill-row"><span class="pill-badge pill-badge-inactive">${pair.projectStatus}</span></div>
          </div>`;
      }
      if (isBlocked) {
        return html`
          <div class="${prClass}">
            <div class="pill-label">Blocked by</div>
            <div class="pill-row">
              ${(pair.blockedByIssueNumbers ?? []).map(n => html`
                <span class="pill-badge pill-badge-blocked">
                  <a class="gh-link" href="${baseUrl}/issues/${n}" target="_blank" rel="noopener noreferrer">#${n}</a>
                </span>
              `)}
            </div>
          </div>`;
      }
      return html`
        <div class="${prClass}">
          <div class="pill-label">PR</div>
          <div class="pill-row"><span class="pill-title">—</span></div>
        </div>`;
    }

    const pr = pair.pr;
    const prUrl = `${baseUrl}/pull/${pr.number}`;
    const badges: string[] = [];
    if (pair.disabled) badges.push('MANUAL');
    if (pr.draft) badges.push('DRAFT');
    if (pair.prPhase === 'review') badges.push('READY');
    if (pair.prPhase === 'completed') badges.push('MERGED');
    const checksIcon = pr.checksStatus === 'success' ? '✓' : pr.checksStatus === 'failure' ? '✗' : pr.checksStatus === 'pending' ? '…' : '';
    if (checksIcon) badges.push(checksIcon);

    return html`
      <div class="${prClass}">
        <div class="pill-label">PR</div>
        <div class="pill-row">
          <span class="pill-number"><a class="gh-link" href="${prUrl}" target="_blank" rel="noopener noreferrer">#${pr.number}</a></span>
          ${badges.map(b => html`<span class="pill-badge">${b}</span>`)}
          <span class="pill-title">${pr.title}</span>
        </div>
      </div>`;
  }

  override render() {
    const pair = this.pair;
    if (!pair) return html``;

    const baseUrl = `https://github.com/${this.owner}/${this.repo}`;
    const style = `--pill-color:${this.color};--pill-rgb:${this.colorRgb};--pill-glow:rgba(${this.colorRgb},0.3)`;

    if (!pair.issue) {
      return html`
        <div class="lifecycle-pill" style="${style}">
          <div class="pill-issue-half empty"></div>
          ${this._prHalf()}
        </div>`;
    }

    const issue = pair.issue;
    const issueUrl = `${baseUrl}/issues/${issue.number}`;
    return html`
      <div class="lifecycle-pill" style="${style}">
        <div class="pill-issue-half">
          <div class="pill-label">Issue</div>
          <div class="pill-row">
            <span class="pill-number">
              <a class="gh-link" href="${issueUrl}" target="_blank" rel="noopener noreferrer">#${issue.number}</a>
            </span>
            <span class="pill-badge">${issue.state.toUpperCase()}</span>
            <span class="pill-title">${issue.title}</span>
          </div>
        </div>
        ${this._prHalf()}
      </div>`;
  }
}

customElements.define('lifecycle-pill', LifecyclePill);
