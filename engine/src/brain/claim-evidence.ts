import type { SourceRecord, WikiClaim } from '@sef/shared';

/**
 * What the vault can actually vouch for. `revision` is the revision each source was read at, so a
 * citation pinned to an older revision is evidence that was superseded, not evidence.
 */
export type EvidenceIndex = Map<string, { revision: string; origin: SourceRecord['origin'] }>;

export type WithheldReason =
  | 'superseded'
  | 'disputed'
  | 'open_question'
  | 'uncited'
  | 'unresolved_source'
  | 'superseded_source'
  | 'foreign_origin';

export interface ClaimVerdict {
  claim: WikiClaim;
  /** Whether this one claim may be asserted as it stands. */
  assertable: boolean;
  reason?: WithheldReason;
  /** The source ids that supported it, for the citation shown next to an asserted claim. */
  sources: string[];
}

/**
 * A claim's provenance decides whether it may be asserted. Peer and model origin are excluded:
 * imported or generated knowledge is not this student's evidence, and it must not be taught back
 * as though it were. Everything else is judged claim by claim — an unsupported claim is withheld,
 * never a reason to drop the page around it.
 */
export function evaluateClaim(claim: WikiClaim, evidence: EvidenceIndex): ClaimVerdict {
  const sources = claim.citations.map((c) => c.sourceId);
  const withheld = (reason: WithheldReason): ClaimVerdict => ({ claim, assertable: false, reason, sources });
  if (claim.status === 'superseded') return withheld('superseded');
  if (claim.status === 'disputed') return withheld('disputed');
  if (claim.kind === 'question') return withheld('open_question');
  if (!claim.citations.length) return withheld('uncited');
  if (claim.origin === 'peer' || claim.origin === 'model') return withheld('foreign_origin');

  for (const citation of claim.citations) {
    const source = evidence.get(citation.sourceId);
    if (!source) return withheld('unresolved_source');
    if (source.revision !== citation.sourceRevision) return withheld('superseded_source');
  }
  return { claim, assertable: true, sources };
}

/** Filters per claim. One unsupported claim removes itself and nothing else. */
export function filterClaims(claims: WikiClaim[], evidence: EvidenceIndex): { kept: WikiClaim[]; withheld: ClaimVerdict[] } {
  const verdicts = claims.map((claim) => evaluateClaim(claim, evidence));
  return {
    kept: verdicts.filter((v) => v.assertable).map((v) => v.claim),
    withheld: verdicts.filter((v) => !v.assertable),
  };
}

/**
 * Renders the claim block a teacher sees. Withheld claims are named and marked rather than
 * dropped, so the model is told they exist but cannot assert them, and the student is not shown a
 * silently shortened account of their own wiki.
 */
export function renderClaims(verdicts: ClaimVerdict[]): string {
  if (!verdicts.length) return 'WIKI CLAIMS: none.';
  const held = verdicts.filter((v) => v.assertable).map((v) => `- [cited: ${v.sources.join(', ')}] ${v.claim.text}`);
  const withheld = verdicts.filter((v) => !v.assertable).map((v) => `- [not assertable: ${v.reason}] ${v.claim.text}`);
  return [
    'WIKI CLAIMS (each judged on its own provenance):',
    ...held,
    ...(withheld.length ? ['CLAIMS YOU MAY NOT ASSERT — mention that they are unsupported, do not state them as fact:', ...withheld] : []),
  ].join('\n');
}

/** The slice of the vault this filter reads. Implemented by the engine's wiki store. */
export interface ClaimReader {
  listPages(): Promise<{ metadata: { claims: WikiClaim[] } | null }[]>;
  listSources(): Promise<Record<string, SourceRecord>>;
}

export async function evidenceIndexFrom(reader: ClaimReader): Promise<EvidenceIndex> {
  const index: EvidenceIndex = new Map();
  for (const [id, record] of Object.entries(await reader.listSources())) index.set(id, { revision: record.revision, origin: record.origin });
  return index;
}

export async function claimsFor(reader: ClaimReader, evidence: EvidenceIndex): Promise<ClaimVerdict[]> {
  const pages = await reader.listPages();
  return pages.flatMap((page) => page.metadata?.claims ?? []).map((claim) => evaluateClaim(claim, evidence));
}