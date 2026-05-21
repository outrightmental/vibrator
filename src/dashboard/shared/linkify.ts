export interface LinkContext {
  prNumber?: number;
  issueNumber?: number;
  commitHash?: string;
  runId?: string;
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function linkifyTextHtml(text: string, baseUrl: string, ctx: LinkContext = {}): string {
  let out = escapeHtml(text);

  out = out.replace(/\bPR #(\d+)\b/g, (_, n: string) =>
    `PR <a class="gh-link" href="${baseUrl}/pull/${n}" target="_blank" rel="noopener noreferrer">#${n}</a>`
  );

  out = out.replace(/\bIssue #(\d+)\b/g, (_, n: string) =>
    `Issue <a class="gh-link" href="${baseUrl}/issues/${n}" target="_blank" rel="noopener noreferrer">#${n}</a>`
  );

  if (ctx.commitHash) {
    const shortHash = ctx.commitHash.slice(0, 7);
    const idx = out.indexOf(shortHash);
    if (idx !== -1) {
      out = out.slice(0, idx)
        + `<a class="gh-link" href="${baseUrl}/commit/${ctx.commitHash}" target="_blank" rel="noopener noreferrer">${shortHash}</a>`
        + out.slice(idx + 7);
    }
  }

  if (ctx.runId) {
    out = out.replace(/Workflow &quot;([^&]+)&quot;/g, (_, name: string) =>
      `Workflow &quot;<a class="gh-link" href="${baseUrl}/actions/runs/${ctx.runId}" target="_blank" rel="noopener noreferrer">${name}</a>&quot;`
    );
  }

  return out;
}
