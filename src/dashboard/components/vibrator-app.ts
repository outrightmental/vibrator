import { LitElement, html } from 'lit';
import type { DashboardState } from '../store/dashboard-store.js';
import type { DashboardStore } from '../store/dashboard-store.js';
import './vibrator-header.js';
import './cylinder-engine.js';
import './lifecycle-list.js';
import './broadcast-feed.js';
import './event-stream.js';
import './status-bar.js';

export class VibratorApp extends LitElement {
  static override properties = {
    store: { attribute: false },
    _state: { attribute: false, state: true },
    _tick: { attribute: false, state: true },
  };

  store: DashboardStore | null = null;
  private _state: DashboardState | null = null;
  private _tick = 0;
  private _unsub: (() => void) | null = null;

  protected override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (this.store) {
      this._state = this.store.getState();
      this._unsub = this.store.subscribe(state => {
        this._state = state;
        this._tick++;
        this.requestUpdate();
      });
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
  }

  override render() {
    const s = this._state;
    if (!s) return html``;

    const baseUrl = `https://github.com/${s.owner}/${s.repo}`;
    const latestIteration = s.cylinders.reduce((max, c) => Math.max(max, c.iterationNumber), 0);
    const nextCycleAtMs = s.cylinders.reduce<number | null>((min, c) => {
      if (c.status === 'idle' && c.nextCycleAtMs !== null && (min === null || c.nextCycleAtMs < min)) {
        return c.nextCycleAtMs;
      }
      return min;
    }, null);

    return html`
      <vibrator-header
        .owner=${s.owner}
        .repo=${s.repo}
        .title=${s.title}
        .multiProject=${s.multiProject}
        .projectCount=${s.sessionCountByRepo.size || s.lifecycleByRepo.size}
        .iteration=${latestIteration}
        .nextCycleAtMs=${nextCycleAtMs}
        .tick=${this._tick}
      ></vibrator-header>
      <div class="main-content">
        <cylinder-engine
          .cylinders=${s.cylinders}
          .maxConcurrency=${s.maxConcurrency}
          .shutdownRequested=${s.shutdownRequested}
          .appShutdown=${s.appShutdown}
          .owner=${s.owner}
          .repo=${s.repo}
          .multiProject=${s.multiProject}
          .tick=${this._tick}
        ></cylinder-engine>
        <lifecycle-list
          .pairs=${s.lastLifecyclePairs}
          .cylinderByIssue=${s.cylinderByIssue}
          .cylinderByPR=${s.cylinderByPR}
          .owner=${s.owner}
          .repo=${s.repo}
          .multiProject=${s.multiProject}
        ></lifecycle-list>
        <broadcast-feed
          .events=${s.broadcastVisible}
          .baseUrl=${baseUrl}
          .multiProject=${s.multiProject}
        ></broadcast-feed>
      </div>
      <div class="event-log-section">
        <div class="panel panel-d">
          <div class="panel-header">📋 EVENT LOG</div>
          <div class="panel-body">
            <event-stream .events=${s.eventStream} .multiProject=${s.multiProject}></event-stream>
          </div>
        </div>
      </div>
      <status-bar
        .connection=${s.connection}
        .eventCount=${s.eventCount}
        .sessionCount=${s.sessionCount}
        .appShutdown=${s.appShutdown}
      ></status-bar>
    `;
  }
}

customElements.define('vibrator-app', VibratorApp);
