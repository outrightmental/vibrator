import { LitElement, html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { BroadcastEventData } from '../store/types.js';
import { linkifyTextHtml } from '../shared/linkify.js';

export class BroadcastEventCard extends LitElement {
  static override styles = css`
    :host { display: block; }

    .broadcast-event {
      padding: 12px 14px;
      margin: 8px 0;
      border-left: 3px solid var(--event-color, #ff00ff);
      border-radius: 2px;
      animation: broadcastEventEntry 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      position: relative;
      overflow: hidden;
      cursor: default;
      font-family: 'IBM Plex Mono', monospace;
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

    .broadcast-event-row.before-row { color: rgba(255, 255, 255, 0.45); }
    .broadcast-event-row.how-row { color: rgba(0, 255, 136, 0.65); padding-left: 4px; }
    .broadcast-event-row.after-row { color: #ffffff; font-weight: 600; }

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

    .broadcast-event-row.after-row .broadcast-event-tag { color: #000; }

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
      0% { transform: translateX(50px) scale(0.88); opacity: 0; filter: brightness(4) blur(4px); }
      20% { transform: translateX(-6px) scale(1.05); opacity: 1; filter: brightness(2.5) blur(0); }
      55% { transform: translateX(2px) scale(1.01); filter: brightness(1.4); }
      100% { transform: translateX(0) scale(1); filter: brightness(1); }
    }

    :host(.exiting) .broadcast-event {
      animation: broadcastEventExit 0.6s ease-in forwards;
      overflow: hidden;
      pointer-events: none;
    }

    @keyframes broadcastEventExit {
      0% { opacity: 1; transform: scale(1); max-height: 200px; margin: 8px 0; padding: 12px 14px; border-width: 3px; }
      40% { opacity: 0.3; transform: translateX(30px) scale(0.93); }
      100% { opacity: 0; transform: translateX(60px) scale(0.87); max-height: 0; margin: 0; padding: 0; border-width: 0; }
    }

    a.gh-link { color: inherit; text-decoration: none; cursor: pointer; }
    a.gh-link:hover { text-decoration: underline; filter: brightness(1.4); }
  `;

  static override properties = {
    event: { type: Object },
    baseUrl: { type: String },
  };

  event: BroadcastEventData | null = null;
  baseUrl = '';

  override render() {
    const ev = this.event;
    if (!ev) return html``;

    const color = ev.color;
    const r = parseInt(color.slice(1, 3), 16) || 0;
    const g = parseInt(color.slice(3, 5), 16) || 0;
    const b = parseInt(color.slice(5, 7), 16) || 0;
    const ctx = { prNumber: ev.prNumber, issueNumber: ev.issueNumber, commitHash: ev.commitHash, runId: ev.runId };

    const dotStyle = `background:${color};box-shadow:0 0 6px ${color}`;
    const typeStyle = `color:${color}`;
    const cardStyle = `border-left-color:${color};background:rgba(${r},${g},${b},0.07)`;
    const nowTagStyle = `background:${color}`;

    return html`
      <div class="broadcast-event" style="${cardStyle}">
        <div class="broadcast-event-header">
          <div class="broadcast-event-header-left">
            <span class="broadcast-event-worker-dot" style="${dotStyle}"></span>
            <span class="broadcast-event-type" style="${typeStyle}">${ev.label || ev.category.toUpperCase()}</span>
          </div>
          <span class="broadcast-event-time">${ev.time}</span>
        </div>
        <div class="broadcast-event-flow">
          <div class="broadcast-event-row before-row">
            <span class="broadcast-event-tag">WAS</span>
            <span>${unsafeHTML(linkifyTextHtml(ev.stateBefore, this.baseUrl, ctx))}</span>
          </div>
          <div class="broadcast-event-row how-row">
            <span class="broadcast-event-tag">HOW</span>
            <span>${unsafeHTML(linkifyTextHtml(ev.changeHow, this.baseUrl, ctx))}</span>
          </div>
          <div class="broadcast-event-row after-row">
            <span class="broadcast-event-tag" style="${nowTagStyle}">NOW</span>
            <span>${unsafeHTML(linkifyTextHtml(ev.stateAfter, this.baseUrl, ctx))}</span>
          </div>
        </div>
        ${ev.excellence ? html`
          <div class="broadcast-event-excellence">
            ✨ ${unsafeHTML(linkifyTextHtml(ev.excellence, this.baseUrl, ctx))}
          </div>
        ` : ''}
      </div>
    `;
  }
}

customElements.define('broadcast-event-card', BroadcastEventCard);
