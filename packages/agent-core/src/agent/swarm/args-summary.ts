const MAX_SUMMARY_LENGTH = 48;

export function summarizeArgs(_toolName: string, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;

  // File-system tools
  for (const key of ['file_path', 'path']) {
    const v = record[key];
    if (typeof v === 'string') return shortenPath(v);
  }

  // Shell-like tools
  if (typeof record['command'] === 'string') return truncate(record['command'], MAX_SUMMARY_LENGTH);

  // URL tools
  if (typeof record['url'] === 'string') return truncate(record['url'], MAX_SUMMARY_LENGTH);

  // Generic fallback: first string field
  for (const v of Object.values(record)) {
    if (typeof v === 'string') return truncate(v, MAX_SUMMARY_LENGTH);
  }
  return undefined;
}

function shortenPath(p: string): string {
  // Strip leading /Users/<user>/ or /home/<user>/ so the home directory doesn't dominate
  const stripped = p.replace(/^\/(?:Users|home)\/[^/]+\//, '');
  const parts = stripped.split('/').filter((s) => s.length > 0);
  if (parts.length <= 3) return parts.join('/');
  return parts.slice(-2).join('/');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}