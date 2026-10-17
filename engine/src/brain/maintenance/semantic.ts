import { normalizeEdgeType, type DroppedItem, type FindingEvidence, type MaintenanceFinding } from '@sef/shared';
import { z } from 'zod';
import { UNTRUSTED_CONTENT_NOTE } from '../../agents/prompts';
import { embedKeyId, type SimilarPair } from '../../embed/hybrid';
import type { PageSnapshot } from '../wiki-store';
import { makeFinding, pageRevisions } from './findings';

/**
 * The semantic review is bounded on purpose: a small set of pages goes in, every suggested
 * finding must name real page and claim ids, and code — not the model — decides what becomes
 * a finding. Anything that does not resolve is dropped with a reason the UI can show.
 */

export const MAX_REVIEW_PAGES = 12;
const MAX_CLAIMS_PER_PAGE = 8;
const MAX_CLAIM_CHARS = 300;
const MAX_TITLE_CHARS = 80;

/** What the review model may draft. Loose by design: validation happens in code below. */
export const SemanticReviewDraftSchema = z.object({
  contradictions: z
    .array(
      z.strictObject({
        pageId: z.string(),
        claimId: z.string(),
        otherPageId: z.string(),
        otherClaimId: z.string(),
        why: z.string(),
      }),
    )
    .max(6)
    .default([]),
  staleClaims: z
    .array(
      z.strictObject({
        pageId: z.string(),
        claimId: z.string(),
        why: z.string(),
        /** The claim on the same page that likely replaces it, when one exists. */
        supersededBy: z.string().optional(),
      }),
    )
    .max(6)
    .default([]),
  connections: z
    .array(
      z.strictObject({
        fromPageId: z.string(),
        toPageId: z.string(),
        type: z.string(),
        why: z.string(),
      }),
    )
    .max(6)
    .default([]),
  questions: z.array(z.strictObject({ pageId: z.string(), question: z.string() })).max(4).default([]),
});
export type SemanticReviewDraft = z.infer<typeof SemanticReviewDraftSchema>;

export const SEMANTIC_REVIEW_INSTRUCTIONS = `
You review one student's markdown wiki for maintenance. You see each page's id, title,
summary, claims (with ids and status) and outgoing links.
${UNTRUSTED_CONTENT_NOTE}

Suggest findings only where the pages genuinely support them — every suggestion must name
real page ids and claim ids from the input. Code validates each one; invented references are
dropped. Fewer, well-founded suggestions beat many guesses. Empty arrays are a valid answer.

- contradictions: two standing claims that disagree. Both claimIds must be real.
- staleClaims: a claim that a newer claim on the same page has effectively replaced.
- connections: two pages that should be linked but are not (link type: prerequisite,
  builds_upon, related_to, contrasts_with, part_of).
- questions: one open question a page's notes raise but never ask.
`.trim();

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * The bounded page selection: pages with standing claims first (that is where contradictions
 * and stale knowledge live), then the rest by recency, capped so the prompt stays small.
 * Similarity pairs from the embedding index add a signal: a page that is near-identical to
 * another it does not link is exactly what a review exists for, so each such partner counts
 * like a standing claim — capped, so similarity alone never outranks the evidence pages.
 */
export function selectReviewPages(pages: PageSnapshot[], options: { similarPairs?: SimilarPair[] | null } = {}): PageSnapshot[] {
  const readable = pages.filter((page) => page.format !== null && page.state === 'ok');
  const byId = new Map(readable.map((page) => [page.id, page]));
  const linked = (from: PageSnapshot, to: string) =>
    (from.metadata?.links ?? []).some((link) => link.toPageId === to) || (from.legacy?.links ?? []).some((link) => link.to === to);
  const unlinkedSimilar = new Map<string, number>();
  for (const pair of options.similarPairs ?? []) {
    const a = byId.get(embedKeyId(pair.a));
    const b = byId.get(embedKeyId(pair.b));
    if (!a || !b || linked(a, b.id) || linked(b, a.id)) continue;
    unlinkedSimilar.set(a.id, (unlinkedSimilar.get(a.id) ?? 0) + 1);
    unlinkedSimilar.set(b.id, (unlinkedSimilar.get(b.id) ?? 0) + 1);
  }
  const scored = readable.map((page) => ({
    page,
    claims: (page.metadata?.claims ?? []).filter((claim) => claim.status === 'current').length,
    similar: Math.min(unlinkedSimilar.get(page.id) ?? 0, 3),
    updated: page.metadata?.updatedAt ?? page.legacy?.updated ?? '',
  }));
  scored.sort((a, b) => b.claims + b.similar - (a.claims + a.similar) || b.updated.localeCompare(a.updated));
  return scored.slice(0, MAX_REVIEW_PAGES).map((entry) => entry.page);
}

/** The prompt the review model sees — ids and claim ids it may reference, nothing else. */
export function buildReviewPrompt(pages: PageSnapshot[]): string {
  const blocks = pages.map((page) => {
    const meta = page.metadata;
    const title = meta?.title ?? page.legacy?.concept ?? page.id;
    const lines = [`- page ${page.id} (${page.kind}) — "${clip(title, MAX_TITLE_CHARS)}"`, `  summary: ${clip(meta?.summary ?? page.legacy?.sections.in_my_words ?? '', 240)}`];
    const claims = (meta?.claims ?? []).filter((claim) => claim.status !== 'superseded').slice(0, MAX_CLAIMS_PER_PAGE);
    if (claims.length) {
      lines.push('  claims:');
      for (const claim of claims) lines.push(`    - ${claim.id} [${claim.kind}/${claim.status}] ${clip(claim.text, MAX_CLAIM_CHARS)}`);
    }
    const linked = (meta?.links ?? []).map((link) => `${link.toPageId} (${link.type})`).join(', ');
    if (linked) lines.push(`  links: ${linked}`);
    const inMyWords = meta?.learner?.inMyWords?.trim() || page.legacy?.sections.in_my_words?.trim();
    if (inMyWords) lines.push(`  in the student's words: ${clip(inMyWords, 300)}`);
    return lines.join('\n');
  });
  return `PAGES UNDER REVIEW (the only pages and claims you may reference):\n\n${blocks.join('\n\n') || '(none)'}`;
}

interface ResolvedClaim {
  page: PageSnapshot;
  claim: NonNullable<PageSnapshot['metadata']>['claims'][number];
}

/**
 * Turns a validated draft into findings. Every reference is resolved against the real pages:
 * a contradiction must name two existing claims, a connection two existing pages with no link
 * between them, and so on. Failures land in `dropped` with a student-readable reason.
 */
export function draftToFindings(draft: SemanticReviewDraft, pages: PageSnapshot[]): { findings: MaintenanceFinding[]; dropped: DroppedItem[] } {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const findings: MaintenanceFinding[] = [];
  const dropped: DroppedItem[] = [];
  const seen = new Set<string>();
  const revisionsFor = (ids: string[]) => pageRevisions(byId, ids);
  const claimOn = (pageId: string, claimId: string): ResolvedClaim | null => {
    const page = byId.get(pageId);
    const claim = page?.metadata?.claims.find((candidate) => candidate.id === claimId);
    return page && claim ? { page, claim } : null;
  };
  const titleOf = (page: PageSnapshot): string => page.metadata?.title ?? page.legacy?.concept ?? page.id;
  const push = (finding: MaintenanceFinding) => {
    if (seen.has(finding.id)) return;
    seen.add(finding.id);
    findings.push(finding);
  };

  for (const item of draft.contradictions) {
    const a = claimOn(item.pageId, item.claimId);
    const b = claimOn(item.otherPageId, item.otherClaimId);
    if (!a || !b) {
      dropped.push({ what: `contradiction ${item.claimId} vs ${item.otherClaimId}`, reason: 'The claim ids do not resolve to real claims.' });
      continue;
    }
    if (a.claim.id === b.claim.id) {
      dropped.push({ what: `contradiction on ${item.claimId}`, reason: 'A claim cannot contradict itself.' });
      continue;
    }
    if (a.claim.status !== 'current' || b.claim.status !== 'current') {
      dropped.push({ what: `contradiction ${item.claimId} vs ${item.otherClaimId}`, reason: 'Only standing claims can contradict — one of these is already retired or disputed.' });
      continue;
    }
    const evidence: FindingEvidence[] = [
      { pageId: a.page.id, claimId: a.claim.id, note: `“${clip(a.claim.text, 200)}”` },
      { pageId: b.page.id, claimId: b.claim.id, note: `“${clip(b.claim.text, 200)}”` },
    ];
    push(
      makeFinding({
        origin: 'semantic',
        kind: 'contradiction',
        pageIds: [...new Set([a.page.id, b.page.id])],
        key: [a.page.id, a.claim.id, b.page.id, b.claim.id],
        title: `Two claims on ${titleOf(a.page)} may contradict each other`,
        detail: `${clip(item.why.trim(), 400) || 'The review flagged these claims as disagreeing.'} Both sides are cited; accepting marks both disputed rather than deleting either.`,
        evidence,
        action: {
          kind: 'repair_page',
          pageId: a.page.id,
          repair: 'dispute_claim',
          claimId: a.claim.id,
          otherPageId: b.page.id,
          otherClaimId: b.claim.id,
        },
        revisions: revisionsFor([a.page.id, b.page.id]),
      }),
    );
  }

  for (const item of draft.staleClaims) {
    const stale = claimOn(item.pageId, item.claimId);
    if (!stale) {
      dropped.push({ what: `stale claim ${item.claimId}`, reason: 'The claim id does not resolve to a real claim.' });
      continue;
    }
    if (stale.claim.status !== 'current') {
      dropped.push({ what: `stale claim ${item.claimId}`, reason: 'The claim is already superseded or disputed.' });
      continue;
    }
    const successor = item.supersededBy ? claimOn(item.pageId, item.supersededBy) : null;
    const evidence: FindingEvidence[] = [{ pageId: stale.page.id, claimId: stale.claim.id, note: `“${clip(stale.claim.text, 200)}”` }];
    if (successor) evidence.push({ pageId: stale.page.id, claimId: successor.claim.id, note: `likely replaced by “${clip(successor.claim.text, 200)}”` });
    push(
      makeFinding({
        origin: 'semantic',
        kind: 'stale_claim',
        pageIds: [stale.page.id],
        key: [stale.page.id, stale.claim.id, successor?.claim.id ?? ''],
        title: `A claim on ${titleOf(stale.page)} may be out of date`,
        detail: clip(item.why.trim(), 400) || 'The review suspects a newer claim has replaced this one.',
        evidence,
        action:
          successor && successor.claim.status === 'current'
            ? { kind: 'repair_page', pageId: stale.page.id, repair: 'supersede_claim', claimId: stale.claim.id, otherClaimId: successor.claim.id }
            : { kind: 'suggestion' },
        revisions: revisionsFor([stale.page.id]),
      }),
    );
  }

  const linked = (from: PageSnapshot, to: string) => (from.metadata?.links ?? []).some((link) => link.toPageId === to);
  for (const item of draft.connections) {
    const from = byId.get(item.fromPageId);
    const to = byId.get(item.toPageId);
    if (!from || !to) {
      dropped.push({ what: `connection ${item.fromPageId} → ${item.toPageId}`, reason: 'One of the page ids does not exist.' });
      continue;
    }
    if (from.id === to.id) {
      dropped.push({ what: `connection ${item.fromPageId} → itself`, reason: 'A page cannot link to itself.' });
      continue;
    }
    if (linked(from, to.id) || linked(to, from.id)) {
      dropped.push({ what: `connection ${from.id} → ${to.id}`, reason: 'These pages are already linked.' });
      continue;
    }
    const type = normalizeEdgeType(item.type);
    if (!type) {
      dropped.push({ what: `connection ${from.id} → ${to.id}`, reason: `"${item.type}" is not an allowed link type.` });
      continue;
    }
    push(
      makeFinding({
        origin: 'semantic',
        kind: 'missing_connection',
        pageIds: [from.id, to.id],
        key: [from.id, to.id],
        title: `${titleOf(from)} and ${titleOf(to)} might belong together`,
        detail: clip(item.why.trim(), 400) || 'The review thinks these pages connect.',
        evidence: [
          { pageId: from.id, note: clip(from.metadata?.summary ?? titleOf(from), 160) },
          { pageId: to.id, note: clip(to.metadata?.summary ?? titleOf(to), 160) },
        ],
        action: { kind: 'add_link', fromPageId: from.id, toPageId: to.id, linkType: type, why: clip(item.why.trim(), 600) || 'Suggested by the maintenance review.' },
        revisions: revisionsFor([from.id, to.id]),
      }),
    );
  }

  for (const item of draft.questions) {
    const page = byId.get(item.pageId);
    const question = item.question.trim();
    if (!page || !question) {
      dropped.push({ what: `question on ${item.pageId}`, reason: 'The page id does not exist or the question is empty.' });
      continue;
    }
    push(
      makeFinding({
        origin: 'semantic',
        kind: 'open_question',
        pageIds: [page.id],
        key: [page.id, question.toLowerCase().slice(0, 80)],
        title: `A question ${titleOf(page)} raises`,
        detail: clip(question, 400),
        evidence: [{ pageId: page.id, note: clip(page.metadata?.summary ?? titleOf(page), 160) }],
        action: { kind: 'repair_page', pageId: page.id, repair: 'append_question', text: clip(question, 600) },
        prompt: question,
        revisions: revisionsFor([page.id]),
      }),
    );
  }

  return { findings, dropped };
}

/**
 * Whether a stored semantic finding still describes the vault as it is now — the claims it
 * cites still exist and stand, the missing link is still missing, and no page it touches was
 * edited since the review ran. Manual edits make stale findings disappear rather than linger.
 */
export function semanticFindingValid(finding: MaintenanceFinding, pages: Map<string, PageSnapshot>): boolean {
  for (const [id, revision] of Object.entries(finding.revisions)) {
    const snapshot = pages.get(id);
    if (!snapshot || snapshot.revision !== revision) return false;
  }
  const claimOn = (pageId: string, claimId?: string) => pages.get(pageId)?.metadata?.claims.find((claim) => claim.id === claimId) ?? null;
  switch (finding.kind) {
    case 'contradiction': {
      const [a, b] = finding.evidence;
      return Boolean(a?.claimId && b?.claimId && claimOn(a.pageId, a.claimId)?.status === 'current' && claimOn(b.pageId, b.claimId)?.status === 'current');
    }
    case 'stale_claim': {
      const cited = finding.evidence[0];
      return Boolean(cited?.claimId && claimOn(cited.pageId, cited.claimId)?.status === 'current');
    }
    case 'missing_connection': {
      const [from, to] = finding.pageIds;
      const snapshot = pages.get(from!);
      if (!snapshot || !to) return false;
      return !(snapshot.metadata?.links ?? []).some((link) => link.toPageId === to);
    }
    case 'open_question':
      return true;
    default:
      return false;
  }
}
