import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  WikiProposalSchema,
  type CourseConceptRef,
  type MaintenanceFinding,
  type ProfileIdentity,
  type WikiEdit,
  type WikiPageDraft,
  type WikiProposal,
} from '@sef/shared';
import type { CourseGraph } from '../course-graph';
import type { PageSnapshot } from '../wiki-store';
import { wikiContentFromConceptPage, type PageMetadataInput } from '../wiki-page-format';

/**
 * Builds one WikiProposal out of the findings the student picked. The ops are ordinary wiki
 * edits computed in code — the proposal files under .meta/proposals/ and goes through the
 * same preview → accept → journaled-apply path a keeper proposal does, so stale base
 * revisions refuse it the same way.
 */

export interface BuildResult {
  proposal: WikiProposal | null;
  /** Findings that contributed at least one operation. */
  filed: string[];
  skipped: { findingId: string; reason: string }[];
}

interface WorkingPage {
  snapshot: PageSnapshot;
  draft: WikiPageDraft;
}

const newClaimId = () => `clm_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

/** The draft a repair rewrites: the page as it stands, kind-correct, before the fix. */
function draftOf(snapshot: PageSnapshot, at: string): WikiPageDraft | null {
  if (snapshot.format === 2 && snapshot.metadata) {
    const { revision: _revision, ...meta } = snapshot.metadata;
    const base = { id: meta.id, title: meta.title, summary: meta.summary, markdown: snapshot.body, courseRefs: meta.courseRefs, claims: meta.claims, links: meta.links };
    switch (meta.kind) {
      case 'concept':
        return { ...base, kind: 'concept', learner: meta.learner ?? { inMyWords: '', stuck: '', connections: '', evidenceIds: [] } };
      case 'source_summary':
        return { ...base, kind: 'source_summary', sourceIds: meta.sourceIds };
      case 'synthesis':
        return { ...base, kind: 'synthesis', sourceIds: meta.sourceIds };
      case 'question':
        return { ...base, kind: 'question', sourceIds: meta.sourceIds };
    }
  }
  if (snapshot.format === 1 && snapshot.legacy) {
    const content = wikiContentFromConceptPage(snapshot.legacy, at);
    const meta: PageMetadataInput = content.metadata;
    return {
      id: meta.id,
      kind: 'concept',
      title: meta.title,
      summary: meta.summary,
      markdown: content.body,
      courseRefs: meta.courseRefs,
      claims: meta.claims,
      links: meta.links,
      learner: meta.learner ?? { inMyWords: '', stuck: '', connections: '', evidenceIds: [] },
    };
  }
  return null;
}

/** courseRefs recomputed from the course sky — the same rule the compiler's normalize applies. */
function repairedCourseRefs(draft: WikiPageDraft, course: CourseGraph, programmeId: string): CourseConceptRef[] {
  const refs = new Map<string, CourseConceptRef>();
  for (const ref of draft.courseRefs) {
    const concept = course.concepts.get(ref.conceptKey);
    if (!concept) continue; // a ref no installed lesson names is dead weight — dropped by the repair
    refs.set(ref.conceptKey, { programmeId, courseId: concept.introducedBy.courseId, conceptKey: ref.conceptKey, lessonId: concept.introducedBy.id });
  }
  const own = course.concepts.get(draft.id);
  if (draft.kind === 'concept' && own) {
    refs.set(own.key, { programmeId, courseId: own.introducedBy.courseId, conceptKey: own.key, lessonId: own.introducedBy.id });
  }
  return [...refs.values()];
}

export function buildMaintenanceProposal(input: {
  findings: MaintenanceFinding[];
  pages: PageSnapshot[];
  /** Ids of sources that still exist in the vault. */
  liveSourceIds: Set<string>;
  course: CourseGraph;
  profile: ProfileIdentity;
  conventionRevision: string;
  at: string;
  /** Page ids already covered by another pending maintenance proposal. */
  claimedFindings?: Set<string>;
}): BuildResult {
  const pages = new Map(input.pages.map((page) => [page.id, page]));
  const working = new Map<string, WorkingPage>();
  const linkOps: WikiEdit[] = [];
  const filed = new Set<string>();
  const skipped: BuildResult['skipped'] = [];

  const workPage = (pageId: string): WorkingPage | null => {
    const existing = working.get(pageId);
    if (existing) return existing;
    const snapshot = pages.get(pageId) ?? null;
    const draft = snapshot ? draftOf(snapshot, input.at) : null;
    if (!snapshot || !draft) return null;
    const entry = { snapshot, draft };
    working.set(pageId, entry);
    return entry;
  };

  /** A finding is stale the moment a page it recorded moved on — refuse rather than guess. */
  const revisionsMatch = (finding: MaintenanceFinding): string | null => {
    for (const [id, revision] of Object.entries(finding.revisions)) {
      const snapshot = pages.get(id);
      if (!snapshot) return `page ${id} is gone`;
      if (snapshot.revision !== revision) return `page ${id} changed since the check ran`;
    }
    return null;
  };

  for (const finding of input.findings) {
    if (input.claimedFindings?.has(finding.id)) {
      skipped.push({ findingId: finding.id, reason: 'Already waiting inside a pending maintenance proposal.' });
      continue;
    }
    const stale = revisionsMatch(finding);
    if (stale) {
      skipped.push({ findingId: finding.id, reason: `Stale: ${stale}. Run the check again.` });
      continue;
    }
    const action = finding.action;

    if (action.kind === 'suggestion' || action.kind === 'rebuild_catalogue') {
      skipped.push({ findingId: finding.id, reason: action.kind === 'rebuild_catalogue' ? 'Catalogue repairs run from Rebuild the index, not through a proposal.' : 'A suggestion, not an edit — nothing to file.' });
      continue;
    }

    if (action.kind === 'add_link') {
      const from = pages.get(action.fromPageId);
      const to = pages.get(action.toPageId);
      if (!from || !to || from.format === null || to.format === null) {
        skipped.push({ findingId: finding.id, reason: 'One of the pages no longer exists in a readable state.' });
        continue;
      }
      const already = (from.metadata?.links ?? from.legacy?.links.map((l) => ({ toPageId: l.to, type: l.type })) ?? []).some(
        (link) => link.toPageId === action.toPageId && link.type === action.linkType,
      );
      if (already) {
        skipped.push({ findingId: finding.id, reason: 'That link already exists.' });
        continue;
      }
      linkOps.push({
        op: 'add_link',
        fromPageId: action.fromPageId,
        link: { toPageId: action.toPageId, type: action.linkType, origin: 'suggested', why: action.why, citations: [] },
      });
      filed.add(finding.id);
      continue;
    }

    // repair_page repairs, one working draft per page so several fixes compose.
    const target = workPage(action.pageId);
    if (!target) {
      skipped.push({ findingId: finding.id, reason: 'The page is gone or unreadable.' });
      continue;
    }
    const draft = target.draft;
    switch (action.repair) {
      case 'adopt_schema':
        if (target.snapshot.format !== 1) {
          skipped.push({ findingId: finding.id, reason: 'Only an earlier-format page needs adopting.' });
          continue;
        }
        filed.add(finding.id); // draftOf already holds the adopted, typed content
        break;
      case 'adopt_drift':
        filed.add(finding.id); // re-writing the same content stamps a matching revision
        break;
      case 'course_mapping':
        draft.courseRefs = repairedCourseRefs(draft, input.course, input.profile.programmeId);
        filed.add(finding.id);
        break;
      case 'dead_source_refs': {
        // Everything pointing at a source that is gone comes off; a claim left with no
        // evidence is removed with it, because the schema refuses unsupported facts.
        // The sourceIds check runs first: a summary or synthesis that would be left with
        // none cannot be repaired, and must not be half-rewritten.
        if (draft.kind === 'source_summary' || draft.kind === 'synthesis') {
          const kept = draft.sourceIds.filter((id) => input.liveSourceIds.has(id));
          if (!kept.length) {
            skipped.push({ findingId: finding.id, reason: 'Removing dead references would leave the page without the sources it summarises — remove the page by hand instead.' });
            continue;
          }
          draft.sourceIds = kept;
        } else if (draft.kind === 'question') {
          draft.sourceIds = draft.sourceIds.filter((id) => input.liveSourceIds.has(id));
        } else {
          draft.learner = { ...draft.learner, evidenceIds: draft.learner.evidenceIds.filter((id) => !id.startsWith('src_') || input.liveSourceIds.has(id)) };
        }
        const citationsLive = draft.claims.map((claim) => ({ ...claim, citations: claim.citations.filter((c) => input.liveSourceIds.has(c.sourceId)) }));
        draft.claims = citationsLive.filter((claim) => (claim.kind !== 'source_fact' && claim.kind !== 'student_belief') || claim.citations.length > 0);
        filed.add(finding.id);
        break;
      }
      case 'dead_links': {
        const readable = (id: string) => (pages.get(id)?.format ?? null) !== null;
        const dead = draft.links.filter((link) => !readable(link.toPageId));
        if (!dead.length) {
          skipped.push({ findingId: finding.id, reason: 'No dead links remain on the page.' });
          continue;
        }
        draft.links = draft.links.filter((link) => readable(link.toPageId));
        for (const link of dead) linkOps.push({ op: 'remove_link', fromPageId: draft.id, toPageId: link.toPageId, linkType: link.type });
        filed.add(finding.id);
        break;
      }
      case 'supersede_claim':
      case 'dispute_claim': {
        const status = action.repair === 'supersede_claim' ? 'superseded' : 'disputed';
        const mark = (page: WorkingPage, claimId: string): boolean => {
          const index = page.draft.claims.findIndex((claim) => claim.id === claimId);
          if (index === -1 || page.draft.claims[index]!.status !== 'current') return false;
          page.draft.claims = page.draft.claims.map((claim, i) => (i === index ? { ...claim, status } : claim));
          return true;
        };
        if (!action.claimId || !mark(target, action.claimId)) {
          skipped.push({ findingId: finding.id, reason: 'The claim is gone or no longer standing.' });
          continue;
        }
        if (action.repair === 'supersede_claim' && action.otherClaimId) {
          draft.claims = draft.claims.map((claim) =>
            claim.id === action.otherClaimId && !claim.supersedes.includes(action.claimId!) ? { ...claim, supersedes: [...claim.supersedes, action.claimId!] } : claim,
          );
        }
        if (action.repair === 'dispute_claim' && action.otherPageId && action.otherClaimId) {
          const other = workPage(action.otherPageId);
          if (other) mark(other, action.otherClaimId);
        }
        filed.add(finding.id);
        break;
      }
      case 'append_question': {
        const text = action.text?.trim();
        if (!text) {
          skipped.push({ findingId: finding.id, reason: 'The question was empty.' });
          continue;
        }
        draft.claims = [...draft.claims, { id: newClaimId(), text, kind: 'question', origin: 'model', status: 'current', citations: [], supersedes: [] }];
        filed.add(finding.id);
        break;
      }
    }
  }

  const operations: WikiEdit[] = [...working.values()].map((entry) => ({ op: 'upsert_page' as const, page: entry.draft }));
  const baseRevisions: Record<string, string | null> = {};
  for (const entry of working.values()) baseRevisions[entry.snapshot.id] = entry.snapshot.revision;
  for (const op of linkOps) {
    const id = op.op === 'add_link' || op.op === 'remove_link' ? op.fromPageId : '';
    if (id && !(id in baseRevisions)) baseRevisions[id] = pages.get(id)?.revision ?? null;
  }
  operations.push(...linkOps);

  if (!operations.length) return { proposal: null, filed: [], skipped };
  const proposal = WikiProposalSchema.safeParse({
    schemaVersion: CONTRACT_VERSION,
    id: `prop_maint_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    profile: input.profile,
    sourceIds: [...filed],
    conventionRevision: input.conventionRevision,
    createdAt: input.at,
    baseRevisions,
    operations,
  });
  if (!proposal.success) {
    return { proposal: null, filed: [], skipped: [...skipped, { findingId: filed.values().next().value ?? 'unknown', reason: `The assembled repairs failed the proposal contract: ${proposal.error.issues[0]?.message ?? 'invalid'}` }] };
  }
  return { proposal: proposal.data, filed: [...filed], skipped };
}
