import type { WikiClaim } from '@sef/shared';

/**
 * What to do with a candidate claim when the page already holds claims.
 *
 * The compiler is cumulative: an update must extend what the student has already
 * established, not overwrite it. Every disposition here is decided by code from the
 * existing claims and the citations the candidate carries — never from how plausible the
 * new text reads. A model may propose any of these; it cannot choose.
 */

export type Disposition =
  | 'add'
  | 'duplicate'
  | 'supersede'
  | 'dispute'
  | 'reject_unsupported';

export interface Decision {
  disposition: Disposition;
  /** The claim this one replaces, for `supersede`. */
  supersedes?: string;
  /** Why, in terms the UI can show a student verbatim. */
  reason: string;
}

export interface MergeInput {
  candidate: Pick<WikiClaim, 'id' | 'text' | 'kind' | 'origin' | 'citations'>;
  existing: readonly WikiClaim[];
}

/**
 * Words carrying no subject. Removing them stops every pair of sentences sharing "the" and
 * "of" from looking like a match, which is what made the conflict threshold unreliable.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'it', 'its', 'that', 'this', 'these', 'those',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'from', 'into', 'up', 'out', 'over',
]);

/** Normalised content words, so whitespace, case and filler do not affect a comparison. */
const normalise = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOPWORDS.has(word));

/** Claims the student or the course put here; the compiler must not quietly drop these. */
const isEstablished = (claim: WikiClaim): boolean =>
  (claim.origin === 'student' || claim.origin === 'course' || claim.origin === 'peer') && claim.status === 'current';

/** Same content words in the same order. */
const sameWords = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((word, i) => word === b[i]);

const hasEvidence = (claim: MergeInput['candidate']): boolean =>
  (claim.kind !== 'source_fact' && claim.kind !== 'student_belief') || claim.citations.length > 0;

/**
 * Jaccard overlap on content words plus how many words the two share outright.
 *
 * The count matters as much as the ratio: "The Moon makes the tides" and "The Sun makes
 * all of the tides" score only 0.4, but they share *makes* and *tides* — the two words that
 * decide what the claim is about. A ratio alone would have filed that as a new fact and
 * quietly lost a contradiction.
 */
function comparison(left: readonly string[], right: readonly string[]): { overlap: number; shared: number } {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return { overlap: 0, shared: 0 };
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return { overlap: shared / (a.size + b.size - shared), shared };
}

/** Restatements this close are the same claim in different words. */
const RESTATEMENT_OVERLAP = 0.8;
/** Below restatement but clearly the same subject: a genuine disagreement. */
const CONFLICT_OVERLAP = 0.35;
/** How many content words two claims must share to be about the same thing at all. */
const CONFLICT_SHARED_WORDS = 2;

const isConflict = (a: readonly string[], b: readonly string[]): boolean => {
  const { overlap: ratio, shared } = comparison(a, b);
  return ratio >= CONFLICT_OVERLAP && shared >= CONFLICT_SHARED_WORDS;
};

/**
 * Decides one candidate against the page it would land on.
 *
 * Order matters: a claim that says nothing new loses to one that contradicts something,
 * because adding a restatement is noise while a contradiction is information.
 */
export function decideClaimMerge({ candidate, existing }: MergeInput): Decision {
  if (!hasEvidence(candidate)) {
    return {
      disposition: 'reject_unsupported',
      reason: 'This claim needs a source before it can be written into your notes.',
    };
  }

  const text = normalise(candidate.text);
  const current = existing.filter(isEstablished);

  // An exact match is still a replacement when the candidate carries more evidence, so the
  // citations accumulate on one claim rather than splitting across duplicates.
  const exact = current.find((claim) => sameWords(normalise(claim.text), text));
  if (exact) {
    return candidate.citations.length > exact.citations.length
      ? { disposition: 'supersede', supersedes: exact.id, reason: 'This restates what you had, with more evidence behind it.' }
      : { disposition: 'duplicate', supersedes: exact.id, reason: 'You already have this.' };
  }

  const restatement = current.find((claim) => comparison(normalise(claim.text), text).overlap >= RESTATEMENT_OVERLAP);
  if (restatement) {
    // A near-identical claim is recorded as a replacement so the evidence accumulates
    // instead of the text being duplicated.
    if (candidate.citations.length > restatement.citations.length) {
      return {
        disposition: 'supersede',
        supersedes: restatement.id,
        reason: 'This restates what you had, with more evidence behind it.',
      };
    }
    return { disposition: 'duplicate', supersedes: restatement.id, reason: 'This repeats what you already have.' };
  }

  // Same subject, different content: a real conflict the student should see.
  const conflict = current.find((claim) => isConflict(normalise(claim.text), text));
  if (conflict) {
    return {
      disposition: 'dispute',
      supersedes: conflict.id,
      reason: 'This does not match what you had before. Both versions are kept until you decide.',
    };
  }

  return { disposition: 'add', reason: 'New and supported, so it is added alongside what you had.' };
}

/**
 * Folds a set of candidate claims into dispositions, deciding each against the state the
 * previous ones produce. A single unsupported candidate therefore cannot poison the rest.
 *
 * Pure: `existing` is never mutated, and applying the returned decisions is the compiler's
 * job — this only says what should happen.
 */
export function planClaimMerges(
  candidates: readonly MergeInput['candidate'][],
  existing: readonly WikiClaim[],
): Array<{ candidateId: string; decision: Decision }> {
  const working: WikiClaim[] = existing.map((claim) => ({ ...claim }));
  return candidates.map((candidate) => {
    const decision = decideClaimMerge({ candidate, existing: working });
    if (decision.disposition === 'supersede' || decision.disposition === 'dispute') {
      const index = working.findIndex((claim) => claim.id === decision.supersedes);
      // A claim already retired is never retired a second time by another candidate.
      if (index !== -1 && working[index]!.status === 'current') {
        working[index] = { ...working[index]!, status: decision.disposition === 'supersede' ? 'superseded' : 'disputed' };
      }
    }
    return { candidateId: candidate.id, decision };
  });
}

/** Claims still standing after a plan has been applied. */
export const currentClaims = (claims: readonly WikiClaim[]): WikiClaim[] => claims.filter((claim) => claim.status === 'current');
