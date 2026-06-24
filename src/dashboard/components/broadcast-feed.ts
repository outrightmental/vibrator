import { LitElement, html } from 'lit';
import type { BroadcastEventData } from '../store/types.js';
import './broadcast-event-card.js';

export class BroadcastFeed extends LitElement {
  static override properties = {
    events: { type: Array },
    baseUrl: { type: String },
  };

  events: BroadcastEventData[] = [];
  baseUrl = '';

  protected override createRenderRoot() { return this; }

  override render() {
    return html`
      <div class="panel panel-c">
        <div class="panel-header">📡 Broadcast Feed</div>
        <div class="panel-body" id="phase-broadcast-content">
          ${this.events.map(ev => html`
            <broadcast-event-card
              .event=${ev}
              .baseUrl=${this.baseUrl}
            ></broadcast-event-card>
          `)}
        </div>
      </div>
    `;
  }
}

customElements.define('broadcast-feed', BroadcastFeed);
