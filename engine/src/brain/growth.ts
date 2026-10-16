import {
  CONTRACT_VERSION,
  type EventEvidence,
  type LearningEvent,
  type LearningEventActor,
  type Revision,
  type SourceRecord,
  type WikiProposal,
} from '@sef/shared';
import { sha256Hex } from '../lib/hash';
import { metadataInputOf, type PagePlan } from './wiki-plan';
import type { PageMetadataInput } from './wiki-page-format';

export interface GrowthContext {
  proposal: WikiProposal;
  /** Pages the proposal would create or change — planProposal already dropped the unchanged ones. */
  plans: Map<string, PagePlan>;
  /** Resolved records for the proposal's sourceIds; ids that are not vault sources are absent. */
  sources: Map<string, SourceRecord>;
  /** Page id → the stamped revision the plan is about to write. */
  revisions: Map<string, Revision>;
  at: string;
}

/** The quiz-result artifacts submitQuiz files next to the quiz are student-produced evidence. */
function originOf(id: string, sources: Map<string, SourceRecord>): 'student' | 'peer' | 'model' {
  const origin = sources.get(id)?.origin;
  // The recorded origin always wins; res_* is only a fallback for quiz artifacts, which are
  // not source records but are by construction this student's own work.
  if (origin === 'student') return 'student';
  if (origin === 'peer') return 'peer';
  if (id.startsWith('res_')) return 'student';
  return 'model';
}

/**
 * Who did the work an event records: the student when student-authored material backs it,
 * a peer when only a peer's share does, otherwise 'model' — generated or collected, never
 * presented as the student's own. knowledgeOnly follows from this by contract.
 */
function actorFor(ids: string[], sources: Map<string, SourceRecord>): LearningEventActor {
  const origins = ids.map((id) => originOf(id, sources));
  if (origins.includes('student')) return 'student';
  if (origins.includes('peer')) return 'peer';
  return 'model';
}

const citationSources = (evidence: EventEvidence[]): string[] =>
  evidence.map((e) => ('sourceId' in e ? e.sourceId : 'ref' in e && e.kind === 'source' ? e.ref : '')).filter(Boolean);

/**
 * Derives the growth events a planned commit represents, one per (kind, page, revision, subject).
 * The id is a hash of exactly that, so a replayed proposal or a retried write produces the same
 * event file — durable and duplicate-free — while a real revision yields a genuinely new event.
 */
export function deriveGrowthEvents(ctx: GrowthContext): LearningEvent[] {
  const events: LearningEvent[] = [];
  const sourceEvidence = (ids: string[]): EventEvidence[] =>
    ids.flatMap((id) => {
      const record = ctx.sources.get(id);
      return record ? [{ kind: 'source' as const, ref: id, revision: record.revision }] : [];
    });

  const emit = (pageId: string, revision: Revision, kind: LearningEvent['kind'], actor: LearningEventActor, evidence: EventEvidence[], dedupe: string, note?: string) => {
    const resolved = evidence.length ? evidence : [{ kind: 'revision' as const, ref: revision }];
    events.push({
      schemaVersion: CONTRACT_VERSION,
      id: `evt_${sha256Hex(`${kind}|${pageId}|${revision}|${dedupe}`).slice(0, 24)}`,
      profile: ctx.proposal.profile,
      pageId,
      at: ctx.at,
      kind,
      actor,
      evidence: resolved,
      ...(note ? { note: note.slice(0, 300) } : {}),
      knowledgeOnly: actor !== 'student',
    });
  };

  for (const [pageId, plan] of ctx.plans) {
    const revision = ctx.revisions.get(pageId);
    if (!revision) continue;
    const before: PageMetadataInput | null = metadataInputOf(plan.snapshot, ctx.at);
    const after = plan.content.metadata;
    const revisionRef: EventEvidence = { kind: 'revision', ref: revision };
    const baseEvidence = [revisionRef, ...sourceEvidence(ctx.proposal.sourceIds)];
    const kind = after.kind;

    const beforeClaims = new Map((before?.claims ?? []).map((claim) => [claim.id, claim]));
    const addedClaims = after.claims.filter((claim) => !beforeClaims.has(claim.id));
    const correctedClaims = after.claims.filter(
      (claim) => beforeClaims.get(claim.id)?.status === 'current' && claim.status !== 'current',
    );
    const disputedNew = after.claims.filter((claim) => !beforeClaims.has(claim.id) && claim.status === 'disputed');
    const beforeLinks = new Set((before?.links ?? []).map((link) => `${link.toPageId}|${link.type}`));
    const addedLinks = after.links.filter((link) => !beforeLinks.has(`${link.toPageId}|${link.type}`));

    if (plan.created) {
      if (kind === 'synthesis') {
        emit(pageId, revision, 'application', actorFor(ctx.proposal.sourceIds, ctx.sources), baseEvidence, '', 'Wove sources into a synthesis');
      } else {
        const evidence = [...baseEvidence, ...addedClaims.flatMap((claim) => claim.citations)];
        emit(pageId, revision, 'encounter', actorFor(citationSources(evidence), ctx.sources), evidence, '', kind === 'question' ? 'Opened a question' : 'First page');
      }
      // A created page can also land its first links in the same proposal.
      for (const link of addedLinks) {
        const actor = link.origin === 'student' ? 'student' : link.origin === 'peer' ? 'peer' : 'model';
        emit(pageId, revision, 'connection', actor, [revisionRef, ...link.citations], `${link.toPageId}|${link.type}`, `→ ${link.toPageId}`);
      }
      continue;
    }

    // Updated pages: each learner-facing delta maps to the event kind it demonstrates.
    if (kind === 'concept' && before?.learner && after.learner) {
      if (after.learner.inMyWords.trim() !== before.learner.inMyWords.trim()) {
        emit(pageId, revision, 'explanation', actorFor(ctx.proposal.sourceIds, ctx.sources), baseEvidence, '', 'Explained it in their own words');
      }
      const stuckBefore = before.learner.stuck.trim();
      const stuckAfter = after.learner.stuck.trim();
      if (stuckAfter !== stuckBefore) {
        if (stuckAfter) emit(pageId, revision, 'struggle', actorFor(ctx.proposal.sourceIds, ctx.sources), baseEvidence, '', 'Marked where they got stuck');
        else emit(pageId, revision, 'correction', actorFor(ctx.proposal.sourceIds, ctx.sources), baseEvidence, 'unstuck', 'Worked through the stuck point');
      }
      const beforeEvidence = new Set(before.learner.evidenceIds);
      for (const evidenceId of after.learner.evidenceIds.filter((id) => !beforeEvidence.has(id))) {
        if (evidenceId.startsWith('res_')) {
          emit(pageId, revision, 'review', 'student', [{ kind: 'artifact', ref: evidenceId }, revisionRef], evidenceId, 'Reviewed with a generated check');
        } else {
          emit(pageId, revision, 'encounter', actorFor([evidenceId], ctx.sources), [...sourceEvidence([evidenceId]), revisionRef], evidenceId, 'New evidence landed');
        }
      }
    }

    if (addedClaims.length) {
      const evidence = [...baseEvidence, ...addedClaims.flatMap((claim) => claim.citations)];
      emit(pageId, revision, 'encounter', actorFor(citationSources(evidence), ctx.sources), evidence, '', 'Collected new material');
    }
    for (const claim of [...correctedClaims, ...disputedNew]) {
      const evidence = [revisionRef, ...claim.citations];
      emit(pageId, revision, 'correction', actorFor(citationSources(evidence), ctx.sources), evidence, claim.id, `Corrected: ${claim.text.slice(0, 80)}`);
    }
    for (const link of addedLinks) {
      const actor = link.origin === 'student' ? 'student' : link.origin === 'peer' ? 'peer' : 'model';
      emit(pageId, revision, 'connection', actor, [revisionRef, ...link.citations], `${link.toPageId}|${link.type}`, `→ ${link.toPageId}`);
    }
    if (kind === 'synthesis') {
      emit(pageId, revision, 'application', actorFor(ctx.proposal.sourceIds, ctx.sources), baseEvidence, '', 'Extended a synthesis');
    }
  }
  return events;
}

/**
 * Where a page's material came from, for the personal sky. A page is 'peer' only when peer
 * material is its whole story — any student-authored evidence (own words, own links, a student
 * source, a quiz artifact) keeps it 'student'. A peer-imported page can never look like the
 * student's own work.
 */
export function pageOrigin(metadata: PageMetadataInput | null, sources: Map<string, SourceRecord>): 'student' | 'peer' {
  if (!metadata) return 'student';
  const studentish =
    Boolean(metadata.learner?.evidenceIds.length) ||
    metadata.claims.some((claim) => claim.origin === 'student') ||
    metadata.links.some((link) => link.origin === 'student') ||
    metadata.sourceIds.some((id) => sources.get(id)?.origin === 'student');
  const peerish =
    metadata.claims.some((claim) => claim.origin === 'peer') ||
    metadata.links.some((link) => link.origin === 'peer') ||
    metadata.sourceIds.some((id) => sources.get(id)?.origin === 'peer');
  return peerish && !studentish ? 'peer' : 'student';
}
