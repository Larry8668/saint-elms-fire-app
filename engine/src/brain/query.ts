import {
  CONTRACT_VERSION,
  IdentifierSchema,
  type SearchMode,
  type SourceRecord,
  type WikiClaimView,
  type WikiGraph,
  type WikiGraphEdge,
  type WikiIndex,
  type WikiLink,
  type WikiPageEntry,
  type WikiPageHit,
  type WikiPageSource,
  type WikiPageView,
} from '@sef/shared';
import { queryTerms } from '../content/search';
import { EMBED_TEXT_MAX, mergeHits, type EmbedSearchFn } from '../embed/hybrid';
import { evaluateClaim, evidenceIndexFrom } from './claim-evidence';
import { legacyPageSummary } from './wiki-page-format';
import type { PageSnapshot } from './wiki-store';

/**
 * The slice of the vault a query reads: page snapshots (not just claims) and the source
 * catalogue. `WikiStore` implements it; tests can fake it. Reads always come from disk,
 * so a query never answers from a stale catalogue.
 */
export interface WikiReader {
  listPages(): Promise<PageSnapshot[]>;
  readPage(id: string): Promise<PageSnapshot | null>;
  listSources(): Promise<Record<string, SourceRecord>>;
  readSource(id: string): Promise<SourceRecord | null>;
}

export interface WikiPageSearch {
  hits: WikiPageHit[];
  /** 'keyword_only' when the semantic lane could not run — the hits are real, just keyword-scored. */
  searchMode: SearchMode;
}

const MAX_SEARCH_TEXT = 24_000;

/** A page's searchable surface: identity first, then compiled claims, then the body. */
function searchText(snapshot: PageSnapshot): { title: string; summary: string; claims: string; body: string } {
  if (snapshot.metadata) {
    const m = snapshot.metadata;
    return {
      title: `${m.title} ${snapshot.id}`,
      summary: m.summary,
      claims: m.claims.map((claim) => claim.text).join('\n'),
      body: snapshot.body.slice(0, MAX_SEARCH_TEXT),
    };
  }
  const legacy = snapshot.legacy;
  return {
    title: `${legacy?.concept ?? snapshot.id} ${snapshot.id}`,
    summary: legacy ? legacyPageSummary(legacy) : '',
    claims: '',
    body: snapshot.body.slice(0, MAX_SEARCH_TEXT),
  };
}

/** The text a page contributes to its vector — the same surface the keyword scorer reads. */
export function pageEmbedText(snapshot: PageSnapshot): string {
  const text = searchText(snapshot);
  return [text.title, text.summary, text.claims, text.body].join('\n').slice(0, EMBED_TEXT_MAX);
}

/** The key a page's vector is stored under — a revision bump re-embeds and evicts the old key. */
export function pageEmbedKey(snapshot: PageSnapshot): string {
  return `${snapshot.id}@${snapshot.revision}`;
}

function entryOf(snapshot: PageSnapshot): WikiPageEntry {
  const meta = snapshot.metadata;
  const legacy = snapshot.legacy;
  return {
    id: snapshot.id,
    kind: meta?.kind ?? 'concept',
    title: meta?.title ?? legacy?.concept ?? snapshot.id,
    summary: meta?.summary ?? (legacy ? legacyPageSummary(legacy) : ''),
    revision: snapshot.revision,
    updatedAt: meta?.updatedAt ?? legacy?.updated ?? null,
    state: snapshot.state,
    sourceIds: meta?.sourceIds ?? [],
    claims: meta?.claims.length ?? 0,
    links: meta?.links.length ?? legacy?.links.length ?? 0,
  };
}

/**
 * The wiki-first read path: a local, deterministic search over the compiled index,
 * page metadata and bodies. It never re-reads raw sources — a saved synthesis is itself
 * a page, so a repeated question finds the worked answer rather than rebuilding it.
 *
 * Provenance is not flattened for convenience: a page read goes through `pageView`,
 * which judges every claim against the current source catalogue, and generated pages
 * stay non-assertable so their prose can be named but never leaned on as evidence.
 */
export class WikiQuery {
  constructor(
    private readonly reader: WikiReader,
    private readonly embed?: EmbedSearchFn,
  ) {}

  /** The compiled catalogue plus source counts — what index.md summarises, as data. */
  async index(): Promise<WikiIndex> {
    const [pages, sources] = await Promise.all([this.reader.listPages(), this.reader.listSources()]);
    const byKind: Record<WikiPageEntry['kind'], number> = { concept: 0, source_summary: 0, synthesis: 0, question: 0 };
    const entries = pages.map(entryOf);
    for (const entry of entries) byKind[entry.kind] += 1;
    return {
      schemaVersion: CONTRACT_VERSION,
      counts: { pages: entries.length, sources: Object.keys(sources).length, byKind },
      pages: entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title)),
    };
  }

  /**
   * The vault as nodes and edges in one read: every readable page, and every link whose
   * target is a page in this vault (a dangling link has nowhere to be drawn). Duplicate
   * links between the same pair keep the first — the student's own link order wins.
   */
  async graph(): Promise<WikiGraph> {
    const snapshots = (await this.reader.listPages()).filter((s) => s.state !== 'malformed' && s.state !== 'newer_schema');
    const ids = new Set(snapshots.map((s) => s.id));
    const edges: WikiGraphEdge[] = [];
    const seen = new Set<string>();
    const nodes = snapshots.map((snapshot) => {
      const entry = entryOf(snapshot);
      const meta = snapshot.metadata;
      const links = meta ? meta.links.map((l) => ({ to: l.toPageId, type: l.type, origin: l.origin })) : (snapshot.legacy?.links ?? []);
      for (const link of links) {
        if (link.to === snapshot.id || !ids.has(link.to)) continue;
        const key = `${snapshot.id}>${link.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: snapshot.id, target: link.to, type: link.type, origin: link.origin });
      }
      const courseIds = [...new Set((meta?.courseRefs ?? []).map((ref) => ref.courseId))];
      return { id: entry.id, kind: entry.kind, title: entry.title, summary: entry.summary, updatedAt: entry.updatedAt, claims: entry.claims, claimTexts: (meta?.claims ?? []).map((claim) => claim.text), sourceIds: entry.sourceIds, courseIds };
    });
    return { schemaVersion: CONTRACT_VERSION, nodes, edges };
  }

  /**
   * Hybrid retrieval over the same pages the keyword scorer reads: weighted keyword
   * scoring plus the embedding lane, union-merged. When the embed model is down or
   * unconfigured the lane answers `null` and the result is the honest keyword-only
   * set, marked so a caller can say which mode produced it.
   */
  async search(query: string, limit = 5): Promise<WikiPageSearch> {
    const snapshots = await this.reader.listPages();
    const terms = queryTerms(query);
    const count = (field: string, term: string) => field.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word === term).length;
    const keyword = new Map<string, number>();
    if (terms.length) {
      const scored = snapshots.map((snapshot) => {
        const text = searchText(snapshot);
        let covered = 0;
        const score = terms.reduce((total, term) => {
          const t = count(text.title, term) * 8;
          const s = count(text.summary, term) * 6;
          const c = Math.min(count(text.claims, term), 4) * 3;
          const b = Math.min(count(text.body, term), 5);
          if (t + s + c + b > 0) covered += 1;
          return total + t + s + c + b;
        }, 0);
        return { snapshot, score: score * (covered / terms.length) };
      });
      const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
      const floor = (ranked[0]?.score ?? 0) * 0.35;
      for (const { snapshot, score } of ranked) {
        if (score >= floor) keyword.set(snapshot.id, score);
      }
    }

    const corpus = new Map(snapshots.map((snapshot) => [pageEmbedKey(snapshot), pageEmbedText(snapshot)]));
    const semantic = this.embed ? await this.embed(corpus, query) : null;
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

    const hits = mergeHits(keyword, semantic)
      .filter((merged) => byId.has(merged.id))
      .slice(0, limit)
      .map((merged) => ({ ...entryOf(byId.get(merged.id)!), score: Math.round(merged.score * 100) / 100, match: merged.match }));
    return { hits, searchMode: semantic ? 'hybrid' : 'keyword_only' };
  }

  /**
   * One page through the permitted view: claims are judged live against the current
   * source catalogue, so a claim whose provenance went stale reads as withheld here —
   * the same verdict a teacher would be given.
   */
  async pageView(id: string): Promise<WikiPageView | null> {
    const snapshot = await this.reader.readPage(id);
    if (!snapshot) return null;
    const meta = snapshot.metadata;
    const legacy = snapshot.legacy;
    const evidence = await evidenceIndexFrom(this.reader);

    const claims: WikiClaimView[] = (meta?.claims ?? []).map((claim) => {
      const verdict = evaluateClaim(claim, evidence);
      return {
        id: claim.id,
        text: claim.text,
        kind: claim.kind,
        origin: claim.origin,
        status: claim.status,
        assertable: verdict.assertable,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        citations: claim.citations,
      };
    });

    const links: WikiLink[] =
      meta?.links ??
      (legacy?.links ?? [])
        .filter((link) => IdentifierSchema.safeParse(link.to).success)
        .map((link) => ({ toPageId: link.to, type: link.type, origin: link.origin, why: link.why ?? 'recorded in the earlier vault', citations: [] }));

    const rested = new Set<string>([
      ...(meta?.sourceIds ?? []),
      ...(meta?.claims ?? []).flatMap((claim) => claim.citations.map((citation) => citation.sourceId)),
      ...links.flatMap((link) => link.citations.map((citation) => citation.sourceId)),
    ]);
    const sources: WikiPageSource[] = [];
    const missingSourceIds: string[] = [];
    for (const sourceId of rested) {
      const record = await this.reader.readSource(sourceId);
      if (record) sources.push({ id: record.id, title: record.title, kind: record.kind, origin: record.origin });
      else missingSourceIds.push(sourceId);
    }

    return {
      schemaVersion: CONTRACT_VERSION,
      id: snapshot.id,
      kind: meta?.kind ?? 'concept',
      title: meta?.title ?? legacy?.concept ?? snapshot.id,
      summary: meta?.summary ?? (legacy ? legacyPageSummary(legacy) : ''),
      revision: snapshot.revision,
      updatedAt: meta?.updatedAt ?? legacy?.updated ?? null,
      state: snapshot.state,
      body: snapshot.body,
      claims,
      links,
      sources,
      missingSourceIds,
      courseRefs: meta?.courseRefs ?? [],
    };
  }
}

/** The text a tool may feed the evidence set for one page — bounded so a giant page stays a page. */
export function pageEvidenceText(view: WikiPageView): string {
  return [view.title, view.summary, view.body].join('\n').slice(0, 6000);
}
