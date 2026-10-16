import type { AnswerSegment, AnswerSegmentKind, TeacherId, VerificationCheck } from '@sef/shared';
import { queryTerms } from '../content/search';
import { parseCitations, type Citation, type EvidenceSet } from './evidence';

/**
 * Answer validation, decided in code. The model's output is split into segments; each is
 * classified (fact, student belief, deduction, uncertainty, question) and checked against the
 * turn's permitted evidence set. Whatever fails is withheld from the served text — a citation is
 * never re-labelled, and an unverifiable statement is never shown and then cosmetically repaired.
 */

/** A bare-tag claim needs this many answer-specific terms overlapping one permitted item to resolve. */
const TAG_SUPPORT_MIN = 3;
/** An uncited fact needs this many to count as measurably grounded in a permitted source. */
const FACT_SUPPORT_MIN = 3;
/** A statement about the student's own mind or notes needs this many against brain or claim evidence. */
const BELIEF_SUPPORT_MIN = 2;
/** A deduction resting on the question itself shares this many terms with it. */
const QUESTION_SUPPORT_MIN = 2;

const TRAILHEAD = /^\s*\**trailhead:?\**\s*/i;
const QUESTION_MARK = /\?\s*[)\].]*$/;
const ABBREV = /\b(e\.g|i\.e|etc|vs|cf|fig|dr|mr|mrs|ms|st|no|vol|approx|resp|al|dept|est)\.*$/i;
const UNCERTAIN =
  /\b(i'?m not (?:sure|certain)|i don'?t know|i can'?t (?:say|tell|verify|check|find|confirm)|i'?m unable|i can only|not (?:in|covered|part of) (?:your|the) (?:released )?(?:lessons|courseware|syllabus|notes)|isn'?t covered|outside (?:your|the) (?:released )?(?:lessons|syllabus|notes|courseware)|don'?t (?:have|see|find) (?:anything|that|it) in|beyond (?:what|the) (?:lessons|material|notes|syllabus)|no (?:released )?lessons? (?:covers?|mentions?|says?|tackles?)|(?:lessons?|notes|syllabus) (?:don'?t|doesn'?t|do not|does not) (?:say|cover|mention)|can'?t (?:ground|back|support|verify) (?:that|this)|honestly,? i (?:don'?t|can'?t|do not|cannot)|nothing (?:in|of) (?:your|the) (?:lessons|notes|syllabus))\b/i;
const BELIEF =
  /\b(you (?:wrote|said|tell|told|believe|believed|asked|ask|got|get|noted|mentioned|showed|see|thought|think|felt|mean|meant|described|gave)|your (?:notes?|page|wiki|own words|words|understanding|question|answer|idea|misconception|guess|work|working|brain|point|example|attempt|reasoning|intuition|records?|logistics)|in your (?:own )?words|you'?ve (?:said|written|been|got|seen|told|asked|described)|you'?re (?:shaky|stuck|unsure|unclear|right|wrong|correct|mixing|confusing)|you'?d (?:said|written)|what you (?:wrote|said|told|believe|asked|mean)|your (?:own|earlier) (?:page|note|idea|answer|record))\b/i;
const DEDUCTION =
  /^(?:so\b|therefore|thus|hence|that means|which means|it follows|in other words|because of that|as a result|putting (?:that|this|them|it) together|all told|overall|then)\b|\b(?:therefore|it follows that|which means|that means|as a result,? (?:so|then)|so it must|so the)\b/i;

const CITATION_ANYWHERE = /\[\s*([a-zA-Z]+)\s*(?::\s*([^\]]{1,160}))?\]/g;

/** Splits on sentence boundaries, keeping inline maths whole and skipping abbreviations. */
function splitSentences(line: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  const re = /[.!?](\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const piece = line.slice(start, m.index + 1);
    if (ABBREV.test(piece.replace(/[*_`]+/g, '').trimEnd())) continue;
    pieces.push(piece);
    start = m.index + m[0].length;
  }
  pieces.push(line.slice(start));

  const balanced: string[] = [];
  for (const piece of pieces) {
    const prev = balanced.at(-1);
    if (prev !== undefined && (prev.match(/\$/g) ?? []).length % 2 === 1) balanced[balanced.length - 1] = `${prev} ${piece.trimStart()}`;
    else balanced.push(piece);
  }
  return balanced.map((p) => p.trim()).filter(Boolean);
}

export interface RawSegment {
  /** Which source line this segment came from, for reassembly. */
  line: number;
  text: string;
}

/** One answer as checkable segments: one per line-sentence, exact text preserved. */
export function splitAnswerSegments(text: string): RawSegment[] {
  const out: RawSegment[] = [];
  text.split('\n').forEach((line, index) => {
    for (const piece of splitSentences(line)) out.push({ line: index, text: piece });
  });
  return out;
}

/**
 * What a segment is doing. The order matters: an explicit question or an honest hedge wins over
 * the claim-bearing kinds, and a segment too thin to claim anything is 'other', not a fact.
 */
export function classifySegment(text: string): AnswerSegmentKind {
  const clean = text.replace(CITATION_ANYWHERE, '').trim();
  if (TRAILHEAD.test(clean) || QUESTION_MARK.test(clean)) return 'question';
  if (UNCERTAIN.test(clean)) return 'uncertainty';
  if (BELIEF.test(clean)) return 'belief';
  if (DEDUCTION.test(clean)) return 'deduction';
  if (clean.endsWith(':') || queryTerms(clean).length < 3) return 'other';
  return 'fact';
}

type SegmentSupport = AnswerSegment['support'];

interface Work {
  line: number;
  raw: string;
  kind: AnswerSegmentKind;
  citations: Citation[];
  keep: boolean;
  support: SegmentSupport;
  sources: string[];
  /** Why a claim-bearing segment was withheld — goes into the check detail. */
  why?: string;
}

const CLAIM_KINDS = new Set<AnswerSegmentKind>(['fact', 'belief', 'deduction']);

/** Verdicts that make a citation fail: the marker is stripped and the statement loses its support. */
const FAILED_VERDICTS = new Set(['forged', 'wrong_owner', 'wrong_class', 'unsupported']);

function failedCitation(c: Citation): boolean {
  if (FAILED_VERDICTS.has(c.verdict)) return true;
  // Declaring a support class over evidence whose support is withheld is a class violation too.
  return c.verdict === 'withheld' && c.declared !== 'withheld';
}

const VERDICT_COPY: Record<string, string> = {
  forged: 'a source that does not exist',
  wrong_owner: 'a source outside this teacher’s evidence',
  wrong_class: 'the wrong class of source',
  unsupported: 'a tag no evidence backs',
  withheld: 'evidence that may be named but not asserted',
};

const sharedWith = (terms: ReadonlySet<string>, text: string): number => {
  let n = 0;
  for (const t of queryTerms(text)) if (terms.has(t)) n += 1;
  return n;
};

/**
 * Decides keep/support from a segment's citations alone. Returns true once citation verdicts have
 * decided it — when false the caller falls back to measured overlap.
 */
function decideByCitations(w: Work): boolean {
  const bad = w.citations.filter(failedCitation);
  if (bad.length) {
    w.keep = false;
    w.why = VERDICT_COPY[bad[0]!.verdict] ?? bad[0]!.verdict;
    return true;
  }
  const good = w.citations.filter((c) => c.verdict === 'cited' || c.verdict === 'attributed');
  if (good.length) {
    w.support = good.some((c) => c.verdict === 'cited') ? 'supported' : 'attributed';
    w.sources = good.map((c) => c.item!.id);
    return true;
  }
  // Every verdict is covered above except naming withheld evidence as withheld: allowed on a
  // belief or deduction, but a fact cannot stand on evidence whose support is withheld.
  if (w.citations.some((c) => c.verdict === 'withheld')) {
    if (w.kind === 'fact') {
      w.keep = false;
      w.why = VERDICT_COPY['withheld'];
    }
    return true;
  }
  return false;
}

/** What the Philosopher's display keeps of a verified citation marker; explicit markers collapse to class tags. */
function tagFor(citation: Citation): string | null {
  const kind = citation.item?.kind;
  if (kind === 'web') return '[web]';
  if (kind === 'lesson' || kind === 'support') return '[course]';
  return null;
}

/**
 * Removes citation markers from served text: explicit `[class: id]` forms always disappear
 * (source chips carry the provenance); on the Philosopher a verified one collapses to its class
 * tag so the [course]/[web] contract still shows. Bare tags stay only on the Philosopher.
 */
function cleanSegmentText(raw: string, teacher: TeacherId, citations: Citation[]): string {
  let text = raw;
  for (const c of citations) {
    if (c.id === undefined) continue;
    const verified = c.verdict === 'cited' || c.verdict === 'attributed';
    text = text.replace(c.raw, teacher === 'philosopher' && verified ? (tagFor(c) ?? '') : '');
  }
  if (teacher !== 'philosopher') {
    for (const c of citations) if (c.id === undefined) text = text.replace(c.raw, '');
  }
  return text.replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

export interface AssessedAnswer {
  /** What may be shown: verified segments, citation markers cleaned, failures withheld. */
  text: string;
  /** The served segments with their kind and support — the response contract's honesty record. */
  segments: AnswerSegment[];
  checks: VerificationCheck[];
  /** Claim-bearing statements withheld before display. */
  withheld: number;
}

export interface AssessOptions {
  teacher: TeacherId;
  /** Statements on an image turn may draw on the attachment itself, which text checks cannot see. */
  hasImage?: boolean;
}

export const UNSUPPORTED_ANSWER: Record<TeacherId, string> = {
  friend: 'The university notes and your confirmed logistics don’t back that, and I won’t invent a source. Try rephrasing, or check your Logistics.',
  guide: 'Your released lessons don’t back that, and I won’t invent a source. Rephrase, or ask me to search your lessons.',
  philosopher: 'Neither your released lessons nor the web results I actually have back that, and I won’t invent a source. Sharpen the question, or consent to a web search.',
};

/**
 * Runs the evidence checks over one answer and returns what may be served.
 *
 * Facts and beliefs need measured support or a resolving citation. Deductions need that support
 * somewhere in the answer or in the question itself. Questions, honest uncertainty and connective
 * text need none. Failed citations cost their statement its support; on the Philosopher a claim
 * line without a resolvable tag is withheld rather than re-labelled.
 */
export function assessAnswer(raw: string, question: string, evidence: EvidenceSet, opts: AssessOptions): AssessedAnswer {
  const questionTerms = new Set(queryTerms(question));
  const segmentTerms = (text: string) => new Set(queryTerms(text).filter((t) => !questionTerms.has(t)));
  const works: Work[] = splitAnswerSegments(raw).map((seg) => {
    const terms = segmentTerms(seg.text);
    return {
      line: seg.line,
      raw: seg.text,
      kind: classifySegment(seg.text),
      citations: parseCitations(seg.text).map((c) => evidence.resolve(c, terms, TAG_SUPPORT_MIN)),
      keep: true,
      support: 'not_required' as SegmentSupport,
      sources: [],
    };
  });

  // Pass 1: everything but deductions, whose support may rest on other segments.
  const deferred: Work[] = [];
  for (const w of works) {
    switch (w.kind) {
      case 'question':
      case 'uncertainty':
      case 'other':
        break;
      case 'fact': {
        if (opts.teacher === 'philosopher') {
          // The contract is per-line provenance: no resolvable tag, no display — never a re-label.
          const bad = w.citations.filter(failedCitation);
          const good = w.citations.filter((c) => c.verdict === 'cited' || c.verdict === 'attributed');
          if (bad.length || !good.length) {
            w.keep = false;
            w.why = bad.length ? (VERDICT_COPY[bad[0]!.verdict] ?? bad[0]!.verdict) : 'no resolvable [course] or [web] tag';
          } else {
            w.support = good.some((c) => c.verdict === 'cited') ? 'supported' : 'attributed';
            w.sources = good.map((c) => c.item!.id);
          }
          break;
        }
        if (!decideByCitations(w)) {
          const hit = evidence.bestSupport(segmentTerms(w.raw));
          if (hit && hit.n >= FACT_SUPPORT_MIN) {
            w.support = 'supported';
            w.sources = [hit.item.id];
          } else if (opts.hasImage) {
            w.support = 'attributed';
            w.sources = ['attachment:image'];
          } else {
            w.keep = false;
            w.why = 'no permitted evidence backs it';
          }
        }
        break;
      }
      case 'belief': {
        if (!decideByCitations(w)) {
          const hit = evidence.bestSupport(segmentTerms(w.raw), ['brain', 'claim', 'logistics']);
          if (hit && hit.n >= BELIEF_SUPPORT_MIN) {
            w.support = 'supported';
            w.sources = [hit.item.id];
          } else if (sharedWith(questionTerms, w.raw) >= 1) {
            w.support = 'not_required'; // it reports on the student's own message
          } else {
            w.keep = false;
            w.why = 'no evidence for the belief it reports';
          }
        }
        break;
      }
      case 'deduction':
        deferred.push(w);
        break;
    }
  }

  // Pass 2: deductions stand if the answer still carries support, or they rest on the question.
  const anySupported = works.some((w) => w.keep && (w.support === 'supported' || w.support === 'attributed'));
  for (const w of deferred) {
    if (decideByCitations(w)) continue;
    if (anySupported || sharedWith(questionTerms, w.raw) >= QUESTION_SUPPORT_MIN || opts.hasImage) w.support = 'not_required';
    else {
      w.keep = false;
      w.why = 'reasoning with no evidence behind it';
    }
  }

  // The Philosopher ends with exactly one Trailhead: extras are dropped, never edited into place.
  const trailheads = works.filter((w) => TRAILHEAD.test(w.raw));
  const rawLines = raw.split('\n').filter((l) => l.trim());
  const lastIsTrailhead = rawLines.length > 0 && TRAILHEAD.test(rawLines.at(-1)!);
  if (trailheads.length > 1) for (const extra of trailheads.slice(1)) extra.keep = false;

  const checks: VerificationCheck[] = [];
  const allCitations = works.flatMap((w) => w.citations);
  const failed = allCitations.filter(failedCitation);
  const namedWithheld = allCitations.filter((c) => c.declared === 'withheld' && c.verdict === 'withheld').length;
  checks.push({
    id: 'citations',
    label: 'Every citation resolves to this teacher’s evidence',
    passed: failed.length === 0,
    detail: failed.length
      ? failed.map((c) => `${c.raw} — ${VERDICT_COPY[c.verdict] ?? c.verdict}`).join('; ')
      : allCitations.length
        ? `${allCitations.length} resolved${namedWithheld ? `, ${namedWithheld} named as withheld` : ''}`
        : 'none declared',
  });

  const claims = works.filter((w) => CLAIM_KINDS.has(w.kind));
  const withheld = claims.filter((w) => !w.keep);
  const backed = claims.filter((w) => w.keep && w.support !== 'not_required').length;
  checks.push({
    id: 'evidence',
    label: 'Factual statements backed by permitted evidence',
    passed: withheld.length === 0,
    detail: withheld.length
      ? `${withheld.length} withheld before display (${[...new Set(withheld.map((w) => w.why).filter(Boolean))].join('; ')})`
      : claims.length
        ? `${backed} of ${claims.length} checked against the evidence`
        : 'nothing factual claimed',
  });

  if (opts.teacher === 'philosopher') {
    const untagged = withheld.filter((w) => w.kind === 'fact').length;
    checks.push({
      id: 'tagged-lines',
      label: 'Every claim line carries a resolvable [course] or [web] tag',
      passed: untagged === 0,
      detail: untagged ? `${untagged} of ${claims.length} claim lines had none` : undefined,
    });
    checks.push({
      id: 'one-trailhead',
      label: 'Ends with exactly one Trailhead question',
      passed: trailheads.length === 1 && lastIsTrailhead,
      detail: trailheads.length !== 1 ? `${trailheads.length} trailheads found` : undefined,
    });
  }

  // Reassemble: kept segments keep their line order; withheld ones are simply gone.
  const kept = works
    .filter((w) => w.keep)
    .map((w) => ({ w, text: cleanSegmentText(w.raw, opts.teacher, w.citations) }))
    .filter(({ text }) => text);
  const byLine = new Map<number, string[]>();
  for (const { w, text } of kept) byLine.set(w.line, [...(byLine.get(w.line) ?? []), text]);
  let text = [...byLine.entries()].sort(([a], [b]) => a - b).map(([, pieces]) => pieces.join(' ')).join('\n');

  // Withheld every claim-bearing segment? Decline honestly rather than serve a hollow answer.
  const servedClaims = kept.some(({ w }) => w.kind !== 'question' && w.kind !== 'other');
  if (withheld.length && !servedClaims) text = UNSUPPORTED_ANSWER[opts.teacher];

  const segments: AnswerSegment[] = kept.map(({ w, text }) => ({
    kind: w.kind,
    text,
    support: w.support,
    sources: w.sources.length ? w.sources : undefined,
  }));

  return { text, segments, checks, withheld: withheld.length };
}
