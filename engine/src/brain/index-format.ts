import { KIND_DIRECTORY, PAGE_KINDS, type PageKind } from './vault-layout';

export interface IndexEntry {
  id: string;
  kind: PageKind;
  revision: string;
  title: string;
  summary: string;
  sourceIds: string[];
  /** Set when the page's on-disk revision no longer matches its content. */
  outOfBand: boolean;
  /** Set when the page's provenance block shows it came from the earlier concept vault. */
  migrated: boolean;
}

const KIND_LABEL: Record<PageKind, string> = {
  concept: 'Concepts',
  source_summary: 'Source summaries',
  synthesis: 'Syntheses',
  question: 'Questions',
};

/** index.md is derived: the catalogue carries every page's summary and where it came from. */
export function renderIndex(entries: IndexEntry[], at: string): string {
  const sorted = [...entries].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
  const lines = [`# Index`, ``, `${sorted.length} page${sorted.length === 1 ? '' : 's'} · updated ${at}`, ``];
  for (const kind of PAGE_KINDS) {
    const rows = sorted.filter((entry) => entry.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${KIND_LABEL[kind]}`, ``);
    for (const row of rows) {
      const notes = [
        row.revision,
        ...(row.sourceIds.length ? [`sources: ${row.sourceIds.join(', ')}`] : []),
        ...(row.migrated ? ['migrated from the earlier concept vault'] : []),
        ...(row.outOfBand ? ['changed outside the keeper'] : []),
      ];
      lines.push(`- [[${row.id}|${row.title}]] · ${notes.join(' · ')}`, `  ${row.summary}`, ``);
    }
    lines.push(`<!-- ${KIND_DIRECTORY[kind]} -->`, ``);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
