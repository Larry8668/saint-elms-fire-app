import type { ProviderConfig } from '@sef/shared';
import { errorFields, log } from '../config';
import type { SettingsReader } from '../settings/store';
import { EMBED_BATCH, embedTexts } from './client';
import { cosine, EMBED_TEXT_MAX, SEMANTIC_FLOOR, SIMILAR_PAIR_FLOOR, type EmbedCorpus, type SimilarPair } from './hybrid';
import { EmbeddingIndex, type EmbeddingIndexFile } from './index';

/** The corpora this index can hold: compiled pages, installed lessons, retained sources. */
export type EmbedScope = 'pages' | 'lessons' | 'sources';
const PAIR_CAP = 200;

interface EnsuredIndex {
  provider: ProviderConfig;
  model: string;
  entries: Record<string, number[]>;
}

/**
 * The semantic lane. Consumers hand over a content-addressed corpus and get cosine
 * scores back; every failure resolves to `null` so the caller's keyword-only path is
 * the honest answer rather than an error that hides results. Writes never block on an
 * embed call — the index fills lazily on read, and a changed key simply re-embeds.
 */
export class EmbeddingService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      index: EmbeddingIndex;
      settings: SettingsReader;
      /** Test seam: replace the HTTP client without a model. */
      embed?: typeof embedTexts;
    },
  ) {}

  /** A ready-to-use lane for one scope, for consumers that take an EmbedSearchFn. */
  for(scope: EmbedScope) {
    return (corpus: EmbedCorpus, query: string) => this.search(scope, corpus, query);
  }

  /** The pairwise-similarity lane for one scope, for consumers that take an EmbedPairsFn. */
  pairsFor(scope: EmbedScope) {
    return (corpus: EmbedCorpus) => this.pairs(scope, corpus);
  }

  /** Cosine ≥ floor per corpus key, or null when the lane could not run. */
  async search(scope: EmbedScope, corpus: EmbedCorpus, query: string): Promise<Map<string, number> | null> {
    if (!corpus.size || !query.trim()) return new Map();
    const ensured = await this.ensure(scope, corpus);
    if (!ensured) return null;
    const qv = (await this.embed(ensured.provider, ensured.model, [query.slice(0, EMBED_TEXT_MAX)]))?.[0];
    if (!qv) {
      log.info('search_mode', { scope, mode: 'keyword_only', reason: 'embed_failed' });
      return null;
    }
    const out = new Map<string, number>();
    for (const [key, vector] of Object.entries(ensured.entries)) {
      const score = cosine(qv, vector);
      if (score >= SEMANTIC_FLOOR) out.set(key, score);
    }
    return out;
  }

  /** Pairs inside the corpus above the similarity floor — the maintenance review's candidates. */
  async pairs(scope: EmbedScope, corpus: EmbedCorpus, floor = SIMILAR_PAIR_FLOOR): Promise<SimilarPair[] | null> {
    if (corpus.size < 2) return [];
    const ensured = await this.ensure(scope, corpus);
    if (!ensured) return null;
    const keys = Object.keys(ensured.entries);
    const out: SimilarPair[] = [];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const score = cosine(ensured.entries[keys[i]!]!, ensured.entries[keys[j]!]!);
        if (score >= floor) out.push({ a: keys[i]!, b: keys[j]!, score });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, PAIR_CAP);
  }

  /** One fill at a time per service, so concurrent searches never double-embed the corpus. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private embed(provider: ProviderConfig, model: string, texts: string[]): Promise<number[][] | null> {
    const call = this.deps.embed ?? embedTexts;
    return call(provider, model, texts).catch((error: unknown) => {
      log.warn('embed_call_failed', { model, texts: texts.length, ...errorFields(error) });
      return null;
    });
  }

  /**
   * Brings the index file in line with the corpus: evict keys the corpus no longer wants,
   * embed keys it has never seen, persist only when something changed. A batch failure
   * keeps the partial progress and reports the lane as unavailable for this call.
   */
  private async ensure(scope: EmbedScope, corpus: EmbedCorpus): Promise<EnsuredIndex | null> {
    return this.serialize(async () => {
      const settings = await this.deps.settings.get();
      const role = settings.roles.embed;
      const provider = role?.model ? settings.providers.find((p) => p.id === role.provider) : undefined;
      if (!role?.model || !provider) {
        log.info('search_mode', { scope, mode: 'keyword_only', reason: 'no_embed_role' });
        return null;
      }

      const stored = await this.deps.index.read(scope);
      const entries = { ...(stored && stored.model === role.model ? stored.entries : {}) };
      let evicted = 0;
      for (const key of Object.keys(entries)) {
        if (!corpus.has(key)) {
          delete entries[key];
          evicted += 1;
        }
      }

      const missing = [...corpus].filter(([key]) => !(key in entries));
      const started = Date.now();
      let embedded = 0;
      let failed = false;
      for (let offset = 0; offset < missing.length && !failed; offset += EMBED_BATCH) {
        const batch = missing.slice(offset, offset + EMBED_BATCH);
        const vectors = await this.embed(provider, role.model, batch.map(([, text]) => text.slice(0, EMBED_TEXT_MAX)));
        if (!vectors) {
          failed = true;
          break;
        }
        batch.forEach(([key], i) => {
          entries[key] = vectors[i]!;
        });
        embedded += batch.length;
      }
      if (evicted > 0 || embedded > 0 || !stored || stored.model !== role.model) {
        const file: EmbeddingIndexFile = { model: role.model, provider: provider.id, entries };
        await this.deps.index.write(scope, file);
        log.info('embed_index_updated', { scope, embedded, evicted, entries: Object.keys(entries).length, ms: Date.now() - started });
      }
      if (failed) {
        log.info('search_mode', { scope, mode: 'keyword_only', reason: 'embed_failed' });
        return null;
      }
      return { provider, model: role.model, entries };
    });
  }
}
