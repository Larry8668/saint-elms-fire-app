import type { BrainLogEntry } from '@sef/shared';

/**
 * log.md is a timeline shared by the legacy keeper and the wiki keeper, so both read and write
 * the same `## [date] kind | title` shape rather than forking the file format.
 */
export function renderLogEntry(entry: BrainLogEntry): string {
  const when = entry.at.slice(0, 19).replace('T', ' ');
  return `## [${when}] ${entry.kind} | ${entry.title}\n${entry.detail ? `${entry.detail}\n` : ''}\n`;
}

export function parseLogEntries(raw: string): BrainLogEntry[] {
  const entries: BrainLogEntry[] = [];
  for (const block of raw.split(/\n(?=## \[)/)) {
    const head = block.match(/^## \[([^\]]+)\] (\S+) \| (.*)$/m);
    if (!head) continue;
    const detail = block.split('\n').slice(1).join('\n').trim();
    entries.push({ at: head[1], kind: head[2], title: head[3], detail: detail || undefined });
  }
  return entries;
}

/** Newest first, for the UI. */
export function recentLogEntries(raw: string, limit: number): BrainLogEntry[] {
  return parseLogEntries(raw).reverse().slice(0, limit);
}
