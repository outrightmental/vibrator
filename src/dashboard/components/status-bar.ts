import { LitElement, html } from 'lit';

export class StatusBar extends LitElement {
  static override properties = {
    connection: { type: String },
    eventCount: { type: Number },
    sessionCount: { type: Number },
    appShutdown: { type: Boolean },
  };

  connection: 'connecting' | 'connected' | 'disconnected' = 'connecting';
  eventCount = 0;
  sessionCount = 0;
  appShutdown = false;

  protected override createRenderRoot() { return this; }

  private _connectionText(): string {
    if (this.appShutdown) return '⏹ SHUTDOWN';
    if (this.connection === 'connected') return '🟢 Connected';
    if (this.connection === 'disconnected') return '🔴 Disconnected';
    return 'Connecting...';
  }

  private _connectionClass(): string {
    if (this.appShutdown) return 'connection-status disconnected';
    return this.connection === 'disconnected' ? 'connection-status disconnected' : 'connection-status';
  }

  private _connectionStyle(): string {
    if (this.appShutdown) return 'background:rgba(255,102,0,0.12);border-color:#ff6600;color:#ff6600;';
    return '';
  }

  override render() {
    return html`
      <div class="status-bar">
        <div class="status-item">
          <div class="status-indicator active"></div>
          <span>Dashboard Active</span>
        </div>
        <div class="stats">
          <div class="stat">
            <span>Events:</span>
            <span class="stat-value">${this.eventCount}</span>
          </div>
          <div class="stat">
            <span>Sessions:</span>
            <span class="stat-value">${this.sessionCount}</span>
          </div>
        </div>
        <div class="${this._connectionClass()}" style="${this._connectionStyle()}">
          ${this._connectionText()}
        </div>
      </div>
    `;
  }
}

customElements.define('status-bar', StatusBar);
