import { LitElement, html } from 'lit';
import type { LifecyclePair } from '../store/types.js';
import { CYLINDER_COLORS, CYLINDER_COLORS_RGB } from '../shared/cylinder-palette.js';
import './lifecycle-pill.js';

function lifecycleTier(pair: LifecyclePair): number {
  if (pair.prPhase === 'review') return 0;
  if (pair.prPhase === 'active') return 1;
  if (pair.prPhase === 'completed') return 2;
  if (pair.prPhase === 'planning') return 3;
  if (pair.prPhase === 'inactive') return 6;
  const blocked = (pair.blockedByIssueNumbers?.length ?? 0) > 0;
  return blocked ? 5 : 4;
}

function compareLifecyclePairs(
  a: LifecyclePair,
  b: LifecyclePair,
  cylinderByIssue: Map<number, number>
): number {
  const aCyl = a.issue ? cylinderByIssue.get(a.issue.number) : undefined;
  const bCyl = b.issue ? cylinderByIssue.get(b.issue.number) : undefined;
  if (aCyl !== undefined && bCyl !== undefined) return aCyl - bCyl;
  if (aCyl !== undefined) return -1;
  if (bCyl !== undefined) return 1;
  const ap = lifecycleTier(a);
  const bp = lifecycleTier(b);
  if (ap !== bp) return ap - bp;
  const aNum = a.issue ? a.issue.number : (a.pr?.number ?? 0);
  const bNum = b.issue ? b.issue.number : (b.pr?.number ?? 0);
  return aNum - bNum;
}

function resolvePillColor(issueNumber: number | null | undefined, cylinderByIssue: Map<number, number>): { hex: string; rgb: string } {
  if (issueNumber != null) {
    const idx = cylinderByIssue.get(issueNumber);
    if (idx !== undefined) {
      return { hex: CYLINDER_COLORS[idx] ?? '#00ffff', rgb: CYLINDER_COLORS_RGB[idx] ?? '0,255,255' };
    }
  }
  return { hex: '#555577', rgb: '85,85,119' };
}

export class LifecycleList extends LitElement {
  static override properties = {
    pairs: { type: Array },
    cylinderByIssue: { attribute: false },
    cylinderByPR: { attribute: false },
    owner: { type: String },
    repo: { type: String },
  };

  pairs: LifecyclePair[] = [];
  cylinderByIssue: Map<number, number> = new Map();
  cylinderByPR: Map<number, number> = new Map();
  owner = '';
  repo = '';

  protected override createRenderRoot() { return this; }

  override render() {
    const sorted = [...this.pairs].sort((a, b) => compareLifecyclePairs(a, b, this.cylinderByIssue));
    const visible = sorted.slice(0, 20);

    const active = this.pairs.filter(p => p.prPhase === 'active' || p.prPhase === 'planning').length;
    const subtitle = this.pairs.length === 0
      ? ''
      : `${this.pairs.length} item${this.pairs.length !== 1 ? 's' : ''} · ${active} in progress`;

    return html`
      <div class="panel panel-b">
        <div class="panel-header">
          ⚡ ISSUE→PR LIFECYCLE
          ${subtitle ? html`<span>${subtitle}</span>` : ''}
        </div>
        <div class="panel-body">
          <div class="lifecycle-content">
            ${visible.length === 0
              ? html`<div class="lifecycle-empty">Connecting to vibrator…</div>`
              : visible.map((pair) => {
                  const issueNum = pair.issue?.number ?? null;
                  const color = resolvePillColor(issueNum, this.cylinderByIssue);
                  const key = pair.issue ? String(pair.issue.number) : `pr-${pair.pr?.number ?? '?'}`;
                  return html`
                    <lifecycle-pill
                      data-key="${key}"
                      .pair=${pair}
                      .color=${color.hex}
                      .colorRgb=${color.rgb}
                      .owner=${this.owner}
                      .repo=${this.repo}
                    ></lifecycle-pill>
                  `;
                })
            }
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('lifecycle-list', LifecycleList);
