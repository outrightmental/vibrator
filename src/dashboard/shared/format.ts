export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatModelName(modelId: string | null): string | null {
  if (!modelId) return null;
  const stripped = modelId.replace(/^claude-/i, '');
  const parts = stripped.split('-');
  let nameEnd = parts.length;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d/.test(parts[i] ?? '')) { nameEnd = i; break; }
  }
  const nameParts = parts.slice(0, nameEnd).map(p => (p ?? '').charAt(0).toUpperCase() + (p ?? '').slice(1));
  const versionParts = parts.slice(nameEnd);
  let result = 'Claude ' + nameParts.join(' ');
  if (versionParts.length > 0) result += ' ' + versionParts.join('.');
  return result;
}
