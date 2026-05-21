import { LitElement, html } from 'lit';
import { formatDuration } from '../shared/format.js';

export class VibratorHeader extends LitElement {
  static override properties = {
    owner: { type: String },
    repo: { type: String },
    iteration: { type: Number },
    nextCycleAtMs: { type: Number },
  };

  owner = '';
  repo = '';
  iteration = 0;
  nextCycleAtMs: number | null = null;

  protected override createRenderRoot() { return this; }

  private _countdown() {
    if (this.nextCycleAtMs === null) return null;
    const ms = this.nextCycleAtMs - Date.now();
    if (ms <= 0) return null;
    return formatDuration(ms);
  }

  override render() {
    const baseUrl = `https://github.com/${this.owner}/${this.repo}`;
    const countdown = this._countdown();
    return html`
      <div class="header">
        <div>
          <div class="header-title">
            <a class="gh-link" href="${baseUrl}" target="_blank" rel="noopener noreferrer">⚡ VIBRATOR</a>
            <span>AI SDLC BROADCAST</span>
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
