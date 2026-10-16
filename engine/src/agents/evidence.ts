import type { SourceRef } from '@sef/shared';
import type { ClaimVerdict } from '../brain/claim-evidence';
import { queryTerms } from '../content/search';

/**
 * The evidence a teacher may cite this turn. A citation is not accepted because the model wrote
 * one — it is resolved against this set: the source must exist in it, belong to the declared
 * citation class, and be assertable. That is the difference between an honest citation and a
 * plausible-looking label.
 */

export type EvidenceKind = 'lesson' | 'support' | 'web' | 'brain' | 'claim';

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  title: string;
  /** The text the teacher was actually shown this turn; measured support is checked against it. */
  text: string;
  /** Whether the item may support an asserted statement. Withheld evidence may be named, never asserted. */
  assertable: boolean;
  /** Why a non-assertable item cannot support a statement, for the check detail. */
  withheldReason?: string;
  /** Whether a citation may name this item. Context blocks support statements but cannot be cited. */
  citable: boolean;
  /** Other names the item answers to in a citation: 'w2', a title, a concept name. */
  aliases?: string[];
}

/**
 * What a citation resolved to. The first two are the only verdicts that may hold a statement up;
 * 'withheld' names real evidence whose support is withheld; the rest are failures.
 */
export type CitationVerdict = 'cited' | 'attributed' | 'withheld' | 'forged' | 'wrong_owner' | 'wrong_class' | 'unsupported';

export interface ParsedCitation {
  /** The bracketed text as written, e.g. '[web: 2]'. */
  raw: string;
  /** The class the model declared: course, lesson, support, web, brain, claim, source, cited, attributed, withheld. */
  declared: string;
  /** The id or locator the model named, if any. */
  id?: string;
}

export interface Citation extends ParsedCitation {
  verdict: CitationVerdict;
  /** The permitted item the citation resolved to, when it did. */
  item?: EvidenceItem;
}

/** Citation classes a model may declare, mapped to the evidence kinds they may name. */
const DECLARED_KINDS: Record<string, EvidenceKind[] | 'any'> = {
  course: ['lesson'],
  lesson: ['lesson', 'support'],
  support: ['support'],
  web: ['web'],
  brain: ['brain'],
  claim: ['claim'],
  cited: ['claim'],
  attributed: ['claim'],
  withheld: ['claim'],
  source: 'any',
};

const CITATION_RE = /\[\s*([a-zA-Z]+)\s*(?::\s*([^\]]{1,160}))?\]/g;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Parses bracketed citations like `[course]`, `[web: 2]`, `[lesson: damped-oscillations]`,
 * `[cited: src-1]`. Brackets that are not a known citation class, or that open a markdown link
 * (`[text](url)`), are not citations.
 */
export function parseCitations(text: string): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const declared = match[1]!.toLowerCase();
    if (!(declared in DECLARED_KINDS)) continue;
    if (text[match.index + match[0].length] === '(') continue;
    out.push({ raw: match[0], declared, id: match[2]?.trim() || undefined });
  }
  return out;
}

export class EvidenceSet {
  constructor(
    readonly items: EvidenceItem[],
    /** Real evidence ids that exist outside this turn's permitted set — a citation naming one is wrong-owner, not forged. */
    private readonly foreignIds: ReadonlySet<string> = new Set(),
  ) {}

  private lookup(id: string): EvidenceItem | undefined {
    const key = norm(id);
    if (!key) return undefined;
    const byId = this.items.find((i) => i.citable && [i.id, ...(i.aliases ?? [])].some((name) => norm(name) === key));
    return byId ?? this.items.find((i) => i.citable && norm(i.title) === key);
  }

  /** Answer-specific terms a segment shares with one item's shown text. */
  overlap(item: EvidenceItem, terms: ReadonlySet<string>): number {
    let n = 0;
    for (const t of queryTerms(item.text)) if (terms.has(t)) n += 1;
    return n;
  }

  /** The best-supported assertable item for a statement, optionally scoped to evidence kinds. */
  bestSupport(terms: ReadonlySet<string>, kinds?: EvidenceKind[]): { item: EvidenceItem; n: number } | null {
    let best: { item: EvidenceItem; n: number } | null = null;
    for (const item of this.items) {
      if (!item.assertable) continue;
      if (kinds && !kinds.includes(item.kind)) continue;
      const n = this.overlap(item, terms);
      if (n > (best?.n ?? 0)) best = { item, n };
    }
    return best;
  }

  /** Whether an id names something real outside this turn's set — a wrong-owner citation. */
  isForeign(id: string): boolean {
    return this.foreignIds.has(norm(id));
  }

  /**
   * Resolves one parsed citation. A bare class tag ([course], [web]) asserts the statement is
   * backed by that class of evidence and is resolved by measured overlap — never taken at the
   * model's word. An explicit id is checked for existence, class and assertability.
   */
  resolve(citation: ParsedCitation, terms: ReadonlySet<string>, supportMin: number): Citation {
    const kinds = DECLARED_KINDS[citation.declared];
    const scope = kinds === 'any' ? undefined : kinds;

    if (citation.id === undefined) {
      const pool = this.items.filter((i) => i.citable && (scope === undefined || scope.includes(i.kind)));
      if (!pool.length) return { ...citation, verdict: 'forged' };
      const hit = this.bestSupport(terms, scope);
      if (hit && hit.n >= supportMin) return { ...citation, verdict: 'cited', item: hit.item };
      const others = scope === undefined ? [] : this.items.filter((i) => i.citable && i.assertable && !scope.includes(i.kind));
      const other = others.map((item) => ({ item, n: this.overlap(item, terms) })).sort((a, b) => b.n - a.n)[0];
      if (other && other.n >= supportMin) return { ...citation, verdict: 'wrong_class' };
      return { ...citation, verdict: 'unsupported' };
    }

    const item = this.lookup(citation.id);
    if (!item) return { ...citation, verdict: this.isForeign(citation.id) ? 'wrong_owner' : 'forged' };
    if (scope !== undefined && !scope.includes(item.kind)) return { ...citation, verdict: 'wrong_class', item };
    if (citation.declared === 'withheld') return { ...citation, verdict: item.assertable ? 'wrong_class' : 'withheld', item };
    if (!item.assertable) return { ...citation, verdict: 'withheld', item };
    return { ...citation, verdict: this.overlap(item, terms) >= 2 ? 'cited' : 'attributed', item };
  }
}

export interface EvidenceInput {
  /** Sources the teacher actually surfaced this turn (retrieval plus tool calls). */
  sources: SourceRef[];
  /** The text each source showed, keyed `${kind}:${id}` — what measured support is checked against. */
  evidenceText?: ReadonlyMap<string, string>;
  /** Wiki-claim verdicts the prompt showed: assertable claims may be cited, withheld ones only named. */
  claimVerdicts?: ClaimVerdict[];
  /** Blocks the model saw (student brain, wiki claims): they may support a statement but can never be cited. */
  contextBlocks?: string[];
  /** Blocks the model saw but may never assert (e.g. the claims block carrying withheld claim text). */
  shieldedBlocks?: string[];
  /** Real evidence ids that exist on this device but were never this teacher's to cite. */
  foreignIds?: Iterable<string>;
}

/** Builds this turn's permitted evidence set from what the teacher was actually shown. */
export function buildEvidenceSet(input: EvidenceInput): EvidenceSet {
  const items: EvidenceItem[] = [];
  let webIndex = 0;
  for (const source of input.sources) {
    const text = input.evidenceText?.get(`${source.kind}:${source.id}`) ?? source.title;
    if (source.kind === 'web') {
      webIndex += 1;
      items.push({ id: source.id, kind: 'web', title: source.title, text, assertable: true, citable: true, aliases: [`w${webIndex}`, `${webIndex}`] });
    } else {
      items.push({ id: source.id, kind: source.kind, title: source.title, text, assertable: true, citable: true });
    }
  }

  for (const verdict of input.claimVerdicts ?? []) {
    const { claim } = verdict;
    items.push({ id: claim.id, kind: 'claim', title: claim.text.slice(0, 80), text: claim.text, assertable: verdict.assertable, withheldReason: verdict.reason, citable: true });
    for (const sourceId of verdict.sources) {
      const existing = items.find((i) => i.kind === 'claim' && i.id === sourceId);
      if (existing?.assertable) continue;
      if (existing) {
        existing.assertable = verdict.assertable;
        existing.withheldReason = verdict.reason;
      } else {
        items.push({ id: sourceId, kind: 'claim', title: sourceId, text: '', assertable: verdict.assertable, withheldReason: verdict.reason, citable: true });
      }
    }
  }

  for (const block of input.contextBlocks ?? []) {
    if (block.trim()) {
      items.push({ id: `context:${items.length}`, kind: 'brain', title: 'the context the teacher was shown', text: block, assertable: true, citable: false });
    }
  }

  for (const block of input.shieldedBlocks ?? []) {
    if (block.trim()) {
      items.push({ id: `shielded:${items.length}`, kind: 'claim', title: 'context the teacher may not assert', text: block, assertable: false, citable: false, withheldReason: 'withheld provenance' });
    }
  }

  const foreignIds = new Set<string>();
  for (const id of input.foreignIds ?? []) foreignIds.add(norm(id));
  return new EvidenceSet(items, foreignIds);
}
