import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  IdentifierSchema,
  WikiProposalSchema,
  conceptKey,
  normalizeEdgeType,
  type CourseConceptRef,
  type ProfileIdentity,
  type SourceCitation,
  type WikiClaim,
  type WikiEdit,
  type WikiLink,
  type WikiPageDraft,
  type WikiProposal,
} from '@sef/shared';
import type { CourseGraph } from '../course-graph';
import { wikiContentFromConceptPage, type LearnerData } from '../wiki-page-format';
import type { PageSnapshot } from '../wiki-store';
import { resolveQuote } from './citations';
import { pageIdFor, type KeeperContext } from './context';
import type { KeeperDraft } from './draft';
import { planClaimMerges, type Decision } from './merge-policy';

export interface DroppedItem {
  /** What was dropped: claim text, link, or a whole page title. */
  what: string;
  reason: string;
}

export interface NormalizedDraft {
  proposal: WikiProposal;
  dropped: DroppedItem[];
}

/**
 * Turns a keeper draft into a WikiProposal, deciding everything the contract leaves open:
 * ids, citations, claim dispositions, link origins and base revisions. The model's prose is
 * the only thing carried through — every pointer, claim and revision is resolved in code.
 * Returns null when nothing survives, which the compiler reports as a no-change checkpoint.
 */
export function normalizeDraft(
  draft: KeeperDraft,
  ctx: KeeperContext & { pageIndex: Map<string, string> },
  opts: { profile: ProfileIdentity; sourceIds: string[]; courseGraph: CourseGraph; at: string },
): NormalizedDraft | null {
  const dropped: DroppedItem[] = [];
  const blobsById = new Map(ctx.blobs.map((blob) => [blob.record.id, blob]));
  const studentSourceIds = ctx.blobs.filter((blob) => blob.record.origin === 'student').map((blob) => blob.record.id);
  const hasStudentSource = studentSourceIds.length > 0;

  // First pass: settle page ids so links can resolve against pages created in this draft.
  // Resolution runs over every page in the vault, not just the prompt's scope — a page the
  // keeper could not see still owns its id and its base revision.
  const inScopeIds = new Set(ctx.pages.map((page) => page.id));
  const pageWork = new Map<string, { draftPage: KeeperDraft['pages'][number]; existing: PageSnapshot | null; inScope: boolean }>();
  const taken = new Set<string>();
  for (const draftPage of draft.pages) {
    const byId = draftPage.id ? ctx.allPages.find((page) => page.id === draftPage.id) ?? null : null;
    const { id, existing } = byId ? { id: byId.id, existing: byId } : pageIdFor(draftPage.title, ctx.allPages, taken);
    taken.add(id);
    const prior = pageWork.get(id);
    pageWork.set(
      id,
      prior
        ? { draftPage: mergeDraftPages(prior.draftPage, draftPage), existing: prior.existing, inScope: prior.inScope || inScopeIds.has(id) }
        : { draftPage, existing, inScope: inScopeIds.has(id) },
    );
  }

  const operations: WikiEdit[] = [];
  const baseRevisions: Record<string, string | null> = {};
  const linkOps: WikiEdit[] = [];
  let claimSeq = 0;
  const newClaimId = () => `clm_${(++claimSeq).toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const citation = (quote: string | undefined): SourceCitation | null => (quote ? resolveQuote(quote, ctx.blobs) : null);
  const originFor = (cite: SourceCitation): WikiClaim['origin'] => {
    const source = blobsById.get(cite.sourceId);
    return (source?.record.origin ?? 'model') as WikiClaim['origin'];
  };

  for (const [id, { draftPage, existing, inScope }] of pageWork) {
    // Candidates: claims the model drafted, each with its resolved citation (or none).
    const candidates = draftPage.claims.flatMap((claim) => {
      const cite = citation(claim.quote);
      if ((claim.kind === 'source_fact' || claim.kind === 'student_belief') && !cite) {
        dropped.push({ what: claim.text, reason: 'No verbatim quote in the provided sources supports it.' });
        return [];
      }
      return [{
        id: newClaimId(),
        text: claim.text.trim(),
        kind: claim.kind,
        // No verbatim quote, no student attribution — the model said this, not the student.
        origin: cite ? originFor(cite) : 'model',
        citations: cite ? [cite] : [],
      }];
    });

    // Merge into the page's existing claims; dispositions are decided by merge policy.
    const existingClaims = existing?.metadata?.claims ?? [];
    const decisions = planClaimMerges(candidates, existingClaims);
    const retired = new Map<string, 'superseded' | 'disputed'>();
    const kept: WikiClaim[] = [];
    for (const { candidateId, decision } of decisions) {
      const candidate = candidates.find((c) => c.id === candidateId)!;
      applyDecision(decision, candidate, kept, retired, dropped);
    }
    const mergedClaims = existingClaims.map((claim) => (retired.has(claim.id) ? { ...claim, status: retired.get(claim.id)! } : claim));
    mergedClaims.push(...kept);

    // A student-authored source becomes page evidence only if the page actually drew on
    // it — the learner block was rewritten, or a kept claim quotes it verbatim.
    const citedStudentIds = new Set(
      kept.flatMap((claim) => claim.citations.map((cite) => cite.sourceId)).filter((id) => studentSourceIds.includes(id)),
    );
    const evidenceToAdd = draftPage.learner && studentSourceIds.length ? studentSourceIds : [...citedStudentIds];
    const learner = learnerFor(draftPage, existing, evidenceToAdd);
    // A page the keeper could not see gets claims merged but keeps its own body — the
    // model rewrote a page it never read, so its prose is not trusted over the vault's.
    const outOfScope = Boolean(existing && !inScope);
    if (outOfScope && draftPage.markdown.trim()) {
      dropped.push({ what: `${draftPage.title} body`, reason: "The page was outside this material's scope, so its body was left as-is." });
    }
    const draftBody = outOfScope ? existing!.body : draftPage.markdown.trim() || existing?.body || `# ${draftPage.title}\n`;
    const summary = outOfScope ? existing!.metadata?.summary ?? draftPage.summary : draftPage.summary.trim() || existing?.metadata?.summary || draftPage.title;

    const page = buildPageDraft({
      id,
      kind: draftPage.kind,
      title: draftPage.title.trim() || existing?.metadata?.title || id,
      summary,
      markdown: draftBody,
      claims: mergedClaims,
      links: existing?.metadata?.links ?? [],
      learner,
      sourceIds: mergedSourceIds(draftPage.kind, existing, opts.sourceIds),
      courseRefs: courseRefsFor(draftPage, existing, opts),
    });
    if (!page) {
      dropped.push({ what: draftPage.title, reason: 'The draft did not produce a valid page for its kind.' });
      continue;
    }
    operations.push({ op: 'upsert_page', page });
    baseRevisions[id] = existing?.revision ?? null;
  }

  // Links are their own ops: the store union-merges them onto whatever the page holds.
  const newPageIds = new Set(pageWork.keys());
  for (const link of draft.links) {
    const from = resolvePageRef(link.from, ctx, newPageIds);
    const to = resolvePageRef(link.to, ctx, newPageIds);
    if (!from || !to) {
      dropped.push({ what: `${link.from} → ${link.to}`, reason: 'A link must point at a page that exists or is created here.' });
      continue;
    }
    if (from === to) {
      dropped.push({ what: `${link.from} → ${link.to}`, reason: 'Self-loop.' });
      continue;
    }
    const type = normalizeEdgeType(link.type);
    if (!type) {
      dropped.push({ what: `${link.from} → ${link.to}`, reason: `Edge type "${link.type}" is not allowed.` });
      continue;
    }
    const cite = citation(link.quote);
    const studentMade = Boolean(cite && blobsById.get(cite.sourceId)?.record.origin === 'student');
    if (link.quote && !cite) dropped.push({ what: `${link.from} → ${link.to}`, reason: 'The quoted statement was not found in the sources; recorded as suggested.' });
    const wikiLink: WikiLink = {
      toPageId: to,
      type,
      origin: studentMade ? 'student' : 'suggested',
      why: link.why.trim().slice(0, 600),
      citations: cite ? [cite] : [],
    };
    linkOps.push({ op: 'add_link', fromPageId: from, link: wikiLink });
    if (!(from in baseRevisions)) {
      const target = ctx.allPages.find((page) => page.id === from) ?? null;
      if (!target && !newPageIds.has(from)) {
        // An existing page outside scope cannot be a link's origin — its base revision is
        // unknowable here, so the link is dropped rather than guessed.
        linkOps.pop();
        dropped.push({ what: `${link.from} → ${link.to}`, reason: 'The source page was not in scope for this material.' });
        continue;
      }
      baseRevisions[from] = target?.revision ?? null;
    }
  }

  if (!operations.length && !linkOps.length) return null;

  const proposal = WikiProposalSchema.safeParse({
    schemaVersion: CONTRACT_VERSION,
    id: `prop_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    profile: opts.profile,
    sourceIds: opts.sourceIds,
    conventionRevision: ctx.conventionsRevision,
    createdAt: opts.at,
    baseRevisions,
    operations: [...operations, ...linkOps],
  });
  if (!proposal.success) {
    // A draft that fails the contract is not "a bad proposal"; it is nothing, and the job
    // records it as a no-change with the reason in the dropped list.
    dropped.push({ what: 'proposal', reason: proposal.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 400) });
    return null;
  }
  return { proposal: proposal.data, dropped };
}

function applyDecision(
  decision: Decision,
  candidate: { id: string; text: string; kind: WikiClaim['kind']; origin: WikiClaim['origin']; citations: SourceCitation[] },
  kept: WikiClaim[],
  retired: Map<string, 'superseded' | 'disputed'>,
  dropped: DroppedItem[],
): void {
  switch (decision.disposition) {
    case 'add':
      kept.push({ ...candidate, status: 'current', supersedes: [] });
      return;
    case 'supersede':
      if (decision.supersedes) retired.set(decision.supersedes, 'superseded');
      kept.push({ ...candidate, status: 'current', supersedes: decision.supersedes ? [decision.supersedes] : [] });
      return;
    case 'dispute':
      if (decision.supersedes) retired.set(decision.supersedes, 'disputed');
      kept.push({ ...candidate, status: 'disputed', supersedes: decision.supersedes ? [decision.supersedes] : [] });
      return;
    case 'duplicate':
    case 'reject_unsupported':
      dropped.push({ what: candidate.text, reason: decision.reason });
      return;
  }
}

/**
 * The student's own sections may only be rewritten when this batch holds student-authored
 * material — a document or a web page can never put words in the student's mouth. An empty
 * draft field leaves the existing words in place; nothing about the learner block is
 * rewritten blind. When student material does land, its source ids join the evidence list
 * so the page's mastery counts the session/capture the words actually came from.
 */
function learnerFor(
  draftPage: KeeperDraft['pages'][number],
  existing: PageSnapshot | null,
  studentEvidenceIds: string[],
): LearnerData | null {
  if (draftPage.kind !== 'concept') return null;
  const prior =
    existing?.metadata?.learner ??
    (existing?.legacy ? wikiContentFromConceptPage(existing.legacy, new Date().toISOString()).metadata.learner : null);
  const base = prior ?? { inMyWords: '', stuck: '', connections: '', evidenceIds: [] };
  const writeWords = studentEvidenceIds.length > 0 && Boolean(draftPage.learner);
  return {
    inMyWords: writeWords ? draftPage.learner!.inMyWords?.trim() || base.inMyWords : base.inMyWords,
    stuck: writeWords ? draftPage.learner!.stuck?.trim() || base.stuck : base.stuck,
    connections: writeWords ? draftPage.learner!.connections?.trim() || base.connections : base.connections,
    evidenceIds: [...new Set([...base.evidenceIds, ...studentEvidenceIds])],
  };
}

function mergedSourceIds(kind: string, existing: PageSnapshot | null, jobSourceIds: string[]): string[] {
  const merged = new Set(existing?.metadata?.sourceIds ?? []);
  if (kind === 'source_summary' || kind === 'synthesis' || kind === 'question') for (const id of jobSourceIds) merged.add(id);
  return [...merged];
}

function courseRefsFor(
  draftPage: KeeperDraft['pages'][number],
  existing: PageSnapshot | null,
  opts: { profile: ProfileIdentity; courseGraph: CourseGraph },
): CourseConceptRef[] {
  const refs = new Map<string, CourseConceptRef>();
  for (const ref of existing?.metadata?.courseRefs ?? []) refs.set(`${ref.courseId}:${ref.conceptKey}`, ref);
  // A concept page's course mapping is decided by the course graph, not the draft.
  if (draftPage.kind === 'concept') {
    const key = existing?.id ?? conceptKey(draftPage.title);
    const concept = opts.courseGraph.concepts.get(key);
    if (concept) {
      refs.set(`${concept.introducedBy.courseId}:${key}`, {
        programmeId: opts.profile.programmeId,
        courseId: concept.introducedBy.courseId,
        conceptKey: key,
        lessonId: concept.introducedBy.id,
      });
    }
  }
  return [...refs.values()];
}

function buildPageDraft(input: {
  id: string;
  kind: KeeperDraft['pages'][number]['kind'];
  title: string;
  summary: string;
  markdown: string;
  claims: WikiClaim[];
  links: WikiLink[];
  learner: LearnerData | null;
  sourceIds: string[];
  courseRefs: CourseConceptRef[];
}): WikiPageDraft | null {
  const base = {
    id: input.id,
    title: input.title.slice(0, 300),
    summary: input.summary.slice(0, 2000),
    markdown: input.markdown,
    courseRefs: input.courseRefs,
    claims: input.claims,
    links: input.links,
  };
  switch (input.kind) {
    case 'concept':
      return { ...base, kind: 'concept', learner: input.learner ?? { inMyWords: '', stuck: '', connections: '', evidenceIds: [] } };
    case 'source_summary':
      return input.sourceIds.length ? { ...base, kind: 'source_summary', sourceIds: input.sourceIds } : null;
    case 'synthesis':
      return input.sourceIds.length ? { ...base, kind: 'synthesis', sourceIds: input.sourceIds } : null;
    case 'question':
      return { ...base, kind: 'question', sourceIds: input.sourceIds };
  }
}

/** Same-title draft pages are folded together rather than competing for one id. */
function mergeDraftPages(a: KeeperDraft['pages'][number], b: KeeperDraft['pages'][number]): KeeperDraft['pages'][number] {
  return {
    ...a,
    summary: b.summary || a.summary,
    markdown: [a.markdown, b.markdown].filter((part) => part.trim()).join('\n\n'),
    learner: a.learner || b.learner ? { ...a.learner, ...b.learner } : undefined,
    claims: [...a.claims, ...b.claims],
  };
}

function resolvePageRef(ref: string, ctx: KeeperContext & { pageIndex: Map<string, string> }, newPageIds: Set<string>): string | null {
  const trimmed = ref.trim();
  if (newPageIds.has(trimmed)) return trimmed;
  if (ctx.pageIndex.has(trimmed)) return trimmed;
  const normalized = trimmed.toLowerCase();
  for (const [id, title] of ctx.pageIndex) {
    if (title.toLowerCase() === normalized) return id;
  }
  const byDraftKey = [...newPageIds].find((id) => id === conceptKey(trimmed));
  return byDraftKey ?? null;
}

export function assertProposal(proposal: WikiProposal): WikiProposal {
  return WikiProposalSchema.parse(proposal);
}

// Keep the schema honest: IdentifierSchema guards every id we mint.
export function isIdentifier(value: string): boolean {
  return IdentifierSchema.safeParse(value).success;
}
