import { LitElement, html } from 'lit';
import type { CylinderState } from '../store/types.js';
import './cylinder-row.js';

export class CylinderEngine extends LitElement {
  static override properties = {
    cylinders: { type: Array },
    maxConcurrency: { type: Number },
    shutdownRequested: { type: Boolean },
    appShutdown: { type: Boolean },
    owner: { type: String },
    repo: { type: String },
    tick: { type: Number },
  };

  cylinders: CylinderState[] = [];
  maxConcurrency = 3;
  shutdownRequested = false;
  appShutdown = false;
  owner = '';
  repo = '';
  tick = 0;

  protected override createRenderRoot() { return this; }

  private _headerText(): string {
    if (this.appShutdown) return '⚙ SHUT DOWN';
    if (this.shutdownRequested) return '⚙ SHUTTING DOWN';
    return `⚙ ${this.maxConcurrency}-CYLINDER ENGINE`;
  }

  override render() {
    return html`
      <div class="panel panel-a">
        <div class="panel-header">${this._headerText()}</div>
        <div class="panel-body">
          ${this.cylinders.map((cyl) => html`
            <cylinder-row
              .cylinder=${cyl}
              .owner=${this.owner}
              .repo=${this.repo}
              .tick=${this.tick}
            ></cylinder-row>
          `)}
        </div>
      </div>
    `;
  }
}

customElements.define('cylinder-engine', CylinderEngine);
