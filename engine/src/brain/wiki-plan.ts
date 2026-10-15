import { CONTRACT_VERSION, type ConceptPage, type WikiProposal } from '@sef/shared';
import type { IndexEntry } from './index-format';
import { VaultConflictError, type VaultConflictDetail } from './vault-errors';
import type { PageKind } from './vault-layout';
import {
  contentRevision,
  legacyPageSummary,
  pageContent,
  wikiContentFromConceptPage,
  type PageMetadata,
  type PageMetadataInput,
  type WikiContent,
  type WikiContentInput,
} from './wiki-page-format';

export type PageState = 'ok' | 'out_of_band' | 'malformed' | 'newer_schema';

/** What one page looks like on disk right now, read fresh every time — never cached across calls. */
export interface PageSnapshot {
  id: string;
  kind: PageKind;
  format: 1 | 2 | null;
  relativePath: string;
  /** The revision a caller must send back to be allowed to write this page. */
  revision: string;
  state: PageState;
  metadata: PageMetadata | null;
  legacy: ConceptPage | null;
  body: string;
  raw: string;
  fileSha256: string;
  bytes: number;
  issue?: string;
}

export interface PagePlan {
  snapshot: PageSnapshot | null;
  content: WikiContentInput;
  created: boolean;
  changed: boolean;
}

export interface PageChange {
  id: string;
  kind: PageKind;
  change: 'created' | 'updated' | 'unchanged';
  revisionBefore: string | null;
  revisionAfter: string;
}

export interface ProposalPlan {
  plans: Map<string, PagePlan>;
  conflicts: VaultConflictDetail[];
  /** Pages an operation named but would not change; reported, never rewritten. */
  unchanged: PageChange[];
}

/** The typed view of a page that is still in the earlier concept format, or null when unreadable. */
export function metadataInputOf(snapshot: PageSnapshot | null, at: string): PageMetadataInput | null {
  if (!snapshot) return null;
  if (snapshot.format === 2 && snapshot.metadata) {
    const { revision: _revision, ...rest } = snapshot.metadata;
    return rest;
  }
  if (snapshot.format === 1 && snapshot.legacy) {
    const { revision: _revision, ...rest } = wikiContentFromConceptPage(snapshot.legacy, at).metadata;
    return rest;
  }
  return null;
}

/**
 * Optimistic concurrency over the whole proposal, before anything is written: every edited page
 * must still be at the revision the proposal was prepared against, or the proposal is refused in full.
 */
export function planProposal(proposal: WikiProposal, snapshots: Map<string, PageSnapshot | null>, at: string): ProposalPlan {
  const conflicts = new Map<string, VaultConflictDetail>();
  const createdIds = new Set<string>();

  for (const op of proposal.operations) {
    const id = op.op === 'upsert_page' ? op.page.id : op.fromPageId;
    const snapshot = snapshots.get(id) ?? null;
    const expected = proposal.baseRevisions[id] ?? null;
    const conflict = (reason: VaultConflictDetail['reason'], found: string | null) => {
      if (!conflicts.has(id)) conflicts.set(id, { id, expected, found, reason });
    };
    if (expected === null) {
      if (snapshot) conflict('exists', snapshot.revision);
      else if (op.op === 'upsert_page') createdIds.add(id);
      else conflict('missing', null);
      continue;
    }
    if (!snapshot) {
      conflict('missing', null);
      continue;
    }
    if (snapshot.state === 'newer_schema' || snapshot.state === 'malformed') {
      conflict(snapshot.state, snapshot.revision);
      continue;
    }
    if (snapshot.revision !== expected) conflict(snapshot.state === 'out_of_band' ? 'out_of_band' : 'revision_changed', snapshot.revision);
  }

  if (conflicts.size) return { plans: new Map(), conflicts: [...conflicts.values()], unchanged: [] };

  const plans = new Map<string, PagePlan>();
  for (const op of proposal.operations) {
    if (op.op === 'upsert_page') {
      const draft = op.page;
      const previous = plans.get(draft.id);
      const snapshot = previous?.snapshot ?? snapshots.get(draft.id) ?? null;
      const base = previous ? previous.content.metadata : metadataInputOf(snapshot, at);
      plans.set(draft.id, {
        snapshot,
        content: {
          metadata: {
            schemaVersion: CONTRACT_VERSION,
            id: draft.id,
            kind: draft.kind,
            state: 'committed',
            title: draft.title,
            summary: draft.summary,
            updatedAt: at,
            courseRefs: draft.courseRefs,
            claims: draft.claims,
            links: mergeLinks(base?.links ?? [], draft.links),
            learner: draft.kind === 'concept' ? draft.learner : null,
            sourceIds: draft.kind === 'concept' ? (base?.sourceIds ?? []) : draft.sourceIds,
            provenance: base?.provenance ?? null,
          },
          body: draft.markdown,
        },
        created: createdIds.has(draft.id),
        changed: true,
      });
      continue;
    }

    const previous = plans.get(op.fromPageId);
    const snapshot = previous?.snapshot ?? snapshots.get(op.fromPageId) ?? null;
    const base = previous ? previous.content.metadata : metadataInputOf(snapshot, at);
    if (!snapshot || !base) continue;
    const links = mergeLinks(base.links, [op.link]);
    plans.set(op.fromPageId, {
      snapshot,
      content: { metadata: { ...base, updatedAt: at, links }, body: previous ? previous.content.body : snapshot.body },
      created: false,
      changed: previous?.changed ?? links.length !== base.links.length,
    });
  }

  // An operation that would not change a byte is dropped, so a replayed proposal settles instead of rewriting.
  const unchanged: PageChange[] = [];
  for (const [id, plan] of plans) {
    if (plan.changed || plan.created) continue;
    plans.delete(id);
    const metadata = metadataInputOf(plan.snapshot, at);
    if (metadata) {
      unchanged.push({ id, kind: metadata.kind, change: 'unchanged', revisionBefore: plan.snapshot?.revision ?? null, revisionAfter: contentRevision(plan.content) });
    }
  }
  return { plans, conflicts: [], unchanged };
}

/** Adopting a page written by the earlier vault: its content is kept and its provenance recorded. */
export function planUpgrade(snapshot: PageSnapshot, at: string): PagePlan {
  if (snapshot.format !== 1 || !snapshot.legacy) {
    throw new VaultConflictError('Only pages still in the earlier concept format can be upgraded', [
      { id: snapshot.id, expected: snapshot.revision, found: snapshot.revision, reason: 'revision_changed' },
    ]);
  }
  const { revision: _revision, ...metadata } = wikiContentFromConceptPage(snapshot.legacy, at).metadata;
  return { snapshot, content: { metadata, body: snapshot.body }, created: false, changed: true };
}

export function indexEntryOf(snapshot: PageSnapshot): IndexEntry | null {
  if (snapshot.format === 2 && snapshot.metadata) {
    return {
      id: snapshot.id,
      kind: snapshot.metadata.kind,
      revision: snapshot.revision,
      title: snapshot.metadata.title,
      summary: snapshot.metadata.summary,
      sourceIds: snapshot.metadata.sourceIds,
      outOfBand: snapshot.state !== 'ok',
      migrated: Boolean(snapshot.metadata.provenance),
    };
  }
  if (snapshot.format === 1 && snapshot.legacy) {
    return {
      id: snapshot.id,
      kind: 'concept',
      revision: snapshot.revision,
      title: snapshot.legacy.concept || snapshot.legacy.key,
      summary: legacyPageSummary(snapshot.legacy),
      sourceIds: [],
      outOfBand: false,
      migrated: true,
    };
  }
  return null;
}

export function indexEntryOfContent(content: WikiContentInput): IndexEntry {
  return {
    id: content.metadata.id,
    kind: content.metadata.kind,
    revision: contentRevision(content),
    title: content.metadata.title,
    summary: content.metadata.summary,
    sourceIds: content.metadata.sourceIds,
    outOfBand: false,
    migrated: Boolean(content.metadata.provenance),
  };
}

export function stamped(content: WikiContentInput): WikiContent {
  return pageContent(content.metadata, content.body);
}

/** Union rather than replace: a proposal may add links, but it never silently drops the student's. */
export function mergeLinks<T extends { to?: string; toPageId?: string; type: string }>(existing: T[], incoming: T[]): T[] {
  const key = (link: { to?: string; toPageId?: string; type: string }) => `${link.toPageId ?? link.to ?? ''}|${link.type}`;
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  for (const link of incoming) {
    if (seen.has(key(link))) continue;
    seen.add(key(link));
    merged.push(link);
  }
  return merged;
}
