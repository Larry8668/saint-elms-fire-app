import type { PageRecordSummary, WikiGraph } from '@sef/shared';

/**
 * Client-side page search for the Brain section: every query term must start a word somewhere in a
 * page's title, summary or claim text. The engine has no HTTP search route, and the list,
 * the map and the wiki tab all filter on the same ids, so one in-memory index serves all three.
 * Building it is linear in the vault; a query is a scan of ~1,400 short strings.
 */
export interface SearchIndex {
  entries: Array<{ id: string; title: string; text: string }>;
}

const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function buildSearchIndex(records: PageRecordSummary[], wiki?: WikiGraph | null): SearchIndex {
  const claims = new Map((wiki?.nodes ?? []).map((n) => [n.id, n.claimTexts?.join('\n') ?? '']));
  return {
    entries: records.map((r) => ({ id: r.id, title: fold(r.title), text: fold(`${r.title}\n${r.id}\n${r.summary ?? ''}\n${claims.get(r.id) ?? ''}`) })),
  };
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** True when `term` starts a word somewhere in `text` — "work" finds "work done", not "network" or "worked out". */
export function hasWordPrefix(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
    if (!isWordChar(text[at - 1])) return true;
  }
  return false;
}

export interface SearchResult {
  /** Matching page ids, best first: title hits before body hits. */
  ids: string[];
  set: Set<string>;
}

export function searchPages(index: SearchIndex, query: string): SearchResult | null {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const scored: Array<{ id: string; score: number }> = [];
  for (const e of index.entries) {
    if (!terms.every((t) => hasWordPrefix(e.text, t))) continue;
    let score = 0;
    for (const t of terms) {
      if (e.title.startsWith(t)) score += 3;
      else if (hasWordPrefix(e.title, t)) score += 2;
    }
    scored.push({ id: e.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const ids = scored.map((s) => s.id);
  return { ids, set: new Set(ids) };
}
