import { LitElement, html } from 'lit';
import { formatDuration } from '../shared/format.js';

export class VibratorHeader extends LitElement {
  static override properties = {
    owner: { type: String },
    repo: { type: String },
    title: { type: String },
    multiProject: { type: Boolean },
    projectCount: { type: Number },
    iteration: { type: Number },
    nextCycleAtMs: { type: Number },
    tick: { type: Number },
  };

  owner = '';
  repo = '';
  title = '';
  multiProject = false;
  projectCount = 0;
  iteration = 0;
  nextCycleAtMs: number | null = null;
  tick = 0;

  protected override createRenderRoot() { return this; }

  private _countdown() {
    if (this.nextCycleAtMs === null) return null;
    const ms = this.nextCycleAtMs - Date.now();
    if (ms <= 0) return null;
    return formatDuration(ms);
  }

  override render() {
    // In multi-project mode there is no single repo, so link to the org (or
    // GitHub) and show how many projects share this dashboard.
    const baseUrl = this.multiProject
      ? `https://github.com/${this.owner || ''}`
      : `https://github.com/${this.owner}/${this.repo}`;
    const countdown = this._countdown();
    const subtitle = this.multiProject && this.projectCount > 1
      ? `${this.projectCount} PROJECTS · AI SDLC BROADCAST`
      : 'AI SDLC BROADCAST';
    return html`
      <div class="header">
        <div>
          <div class="header-title">
            <a class="gh-link" href="${baseUrl}" target="_blank" rel="noopener noreferrer">⚡ ${(this.title || 'VIBRATOR').toUpperCase()}</a>
            <span>${subtitle}</span>
          </div>
        </div>
        ${this.iteration > 0 ? html`
          <div class="iteration-info">
            <div class="iteration-label">CYCLE</div>
            <div class="iteration-number">${this.iteration}</div>
          </div>
        ` : ''}
        ${countdown !== null ? html`
          <div class="countdown state-waiting">
            <div class="countdown-label">NEXT</div>
            <div class="countdown-timer">${countdown}</div>
          </div>
        ` : ''}
      </div>
    `;
  }
}

customElements.define('vibrator-header', VibratorHeader);
