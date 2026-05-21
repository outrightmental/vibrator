import { LitElement, html } from 'lit';

export class VibratorHeader extends LitElement {
  static override properties = {
    owner: { type: String },
    repo: { type: String },
  };

  owner = '';
  repo = '';

  protected override createRenderRoot() { return this; }

  override render() {
    const baseUrl = `https://github.com/${this.owner}/${this.repo}`;
    return html`
      <div class="header">
        <div>
          <div class="header-title">
            <a class="gh-link" href="${baseUrl}" target="_blank" rel="noopener noreferrer">⚡ VIBRATOR</a>
            <span>AI SDLC BROADCAST</span>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('vibrator-header', VibratorHeader);
