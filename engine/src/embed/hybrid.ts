import type { SearchMatchKind } from '@sef/shared';

/**
 * The seam between a keyword search and the vector index. A consumer builds the corpus
 * (content-addressed key → the text that should be embedded); the lane answers cosine
 * scores per key, or `null` when the lane could not run this time — model absent,
 * unreachable, wrong provider kind — and the caller falls back to keyword-only and says so.
 */
export type EmbedCorpus = Map<string, string>;
export type EmbedSearchFn = (corpus: EmbedCorpus, query: string) => Promise<Map<string, number> | null>;
export type EmbedPairsFn = (corpus: EmbedCorpus) => Promise<SimilarPair[] | null>;

export interface SimilarPair {
  a: string;
  b: string;
  score: number;
}

/** Below this cosine a candidate does not count as a semantic hit — keeps embedding noise out. */
export const SEMANTIC_FLOOR = 0.45;
/** The bar for "these two pages may be the same topic" in maintenance review selection. */
export const SIMILAR_PAIR_FLOOR = 0.75;
/** What one document contributes to its vector — bounded so a giant page stays a page. */
export const EMBED_TEXT_MAX = 6_000;

/** The entity id a content-addressed embed key stands for (`pageId@rev` → `pageId`). */
export const embedKeyId = (key: string): string => key.split('@')[0]!;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export interface MergedHit {
  id: string;
  score: number;
  match: SearchMatchKind;
}

/**
 * Union-merge the two retrieval lanes. Each lane has already applied its own admission
 * rule (the keyword floor, the cosine floor); a hit admitted by either lane stays in,
 * and the blended score — normalized keyword weight plus cosine — orders the union, so
 * a page found by both lanes naturally outranks a page found by one.
 */
export function mergeHits(keyword: Map<string, number>, semantic: Map<string, number> | null): MergedHit[] {
  const kwTop = Math.max(0, ...keyword.values());
  const merged = new Map<string, MergedHit>();
  for (const [id, score] of keyword) {
    merged.set(id, { id, score: kwTop > 0 ? score / kwTop : 0, match: 'keyword' });
  }
  for (const [key, score] of semantic ?? []) {
    const id = embedKeyId(key);
    const norm = Math.max(0, Math.min(1, score));
    const existing = merged.get(id);
    if (existing) {
      existing.score += norm;
      existing.match = 'both';
    } else {
      merged.set(id, { id, score: norm, match: 'semantic' });
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}
