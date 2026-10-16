import type { FindingEvidence, MaintenanceFinding, SourceRecord } from '@sef/shared';
import type { CourseGraph } from '../course-graph';
import type { PageSnapshot } from '../wiki-store';
import { makeFinding, pageRevisions } from './findings';

/** Raw bytes past which a page is flagged; learner-prose length is lint's own concern. */
export const OVERSIZED_PAGE_BYTES = 24 * 1024;

export interface StructuralInput {
  pages: PageSnapshot[];
  sources: Record<string, SourceRecord>;
  indexText: string | null;
  course: CourseGraph;
}

/** `[[id]]` or `[[id|alias]]` references inside a page body. */
const BODY_LINK_PATTERN = /\[\[([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\|[^\]]*)?\]\]/g;
/** An index row: `- [[id|title]] · revision · …`. The revision token is optional. */
const INDEX_ROW_PATTERN = /^-\s+\[\[([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\|[^\]]*)?\]\](.*)$/gm;
const INDEX_REVISION_PATTERN = /\b(?:rev|file)-[a-f0-9]{40}\b/;

/** What a page's links point at, whichever format the file is in. */
function outboundLinks(page: PageSnapshot): string[] {
  if (page.format === 2 && page.metadata) return page.metadata.links.map((link) => link.toPageId);
  if (page.format === 1 && page.legacy) return page.legacy.links.map((link) => link.to);
  return [];
}

const titleOf = (page: PageSnapshot): string => page.metadata?.title ?? page.legacy?.concept ?? page.id;

/**
 * The deterministic structural pass: orphan, missing source/citation, dead and unrecorded
 * links, unindexed pages, bad course mappings, oversized files and schema/revision checks.
 * Pure over the vault state it is given — the same input always finds the same findings.
 */
export function structuralFindings(input: StructuralInput): MaintenanceFinding[] {
  const pages = new Map(input.pages.map((page) => [page.id, page]));
  const liveIds = new Set(input.pages.filter((page) => page.format !== null).map((page) => page.id));
  const findings: MaintenanceFinding[] = [];
  const revisionsFor = (ids: string[]) => pageRevisions(pages, ids);

  const inbound = new Map<string, string[]>();
  for (const page of input.pages) {
    for (const target of outboundLinks(page)) {
      inbound.set(target, [...(inbound.get(target) ?? []), page.id]);
    }
  }
  const liveLinks = (page: PageSnapshot) => outboundLinks(page).filter((id) => liveIds.has(id));

  // -- schema / revision: files the vault can see but cannot read normally ---------------
  for (const page of input.pages) {
    if (page.format === null) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'schema_issue',
          pageIds: [page.id],
          key: [page.id, page.issue ?? 'unreadable'],
          title: `${titleOf(page)} is not readable`,
          detail: page.state === 'newer_schema' ? 'This page was written by a newer engine version.' : `This page does not match the page schema: ${page.issue ?? 'unknown'}.`,
          evidence: [{ pageId: page.id, note: page.issue ?? 'unreadable page file' }],
          revisions: revisionsFor([page.id]),
        }),
      );
      continue;
    }
    if (page.format === 1) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'schema_issue',
          pageIds: [page.id],
          key: [page.id, 'legacy_format'],
          title: `${titleOf(page)} is still in the earlier page format`,
          detail: 'This page predates the typed schema. Adopting it keeps every word and records where its unresolved provenance went.',
          action: { kind: 'repair_page', pageId: page.id, repair: 'adopt_schema' },
          revisions: revisionsFor([page.id]),
        }),
      );
      continue;
    }
    if (page.metadata && page.metadata.id !== page.id) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'schema_issue',
          pageIds: [page.id],
          key: [page.id, 'id_mismatch'],
          title: `${titleOf(page)}'s frontmatter names a different page`,
          detail: `The file is named ${page.id} but its frontmatter says ${page.metadata.id}.`,
          evidence: [{ pageId: page.id, note: `frontmatter id: ${page.metadata.id}` }],
          revisions: revisionsFor([page.id]),
        }),
      );
    }
    if (page.state === 'out_of_band') {
      const duplicated = page.issue?.includes('more than one kind folder') ?? false;
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'revision_drift',
          pageIds: [page.id],
          key: [page.id, duplicated ? 'duplicated' : 'drift'],
          title: `${titleOf(page)} changed outside the keeper`,
          detail: duplicated
            ? 'This page id exists in more than one kind folder; the keeper cannot tell which is canonical.'
            : 'The file on disk no longer matches its stamped revision — an edit happened outside the proposal pipeline. Accepting the repair adopts the on-disk words as the new revision.',
          evidence: [{ pageId: page.id, note: page.issue ?? 'changed outside the keeper' }],
          action: duplicated ? { kind: 'suggestion' } : { kind: 'repair_page', pageId: page.id, repair: 'adopt_drift' },
          revisions: revisionsFor([page.id]),
        }),
      );
    }
  }

  // -- missing sources and citations ------------------------------------------------------
  // Only references the repair can actually reach are flagged: a concept page's metadata
  // sourceIds are keeper-managed provenance — the page draft contract preserves them rather
  // than editing them, so a dead one is reported only inside a claim or the learner's evidence.
  for (const page of input.pages) {
    if (page.format !== 2 || !page.metadata || page.state !== 'ok') continue;
    const deadSourceIds = page.kind === 'concept' ? [] : page.metadata.sourceIds.filter((id) => !input.sources[id]);
    const deadEvidence = (page.metadata.learner?.evidenceIds ?? []).filter((id) => id.startsWith('src_') && !input.sources[id]);
    const deadCitations = [
      ...new Set(
        page.metadata.claims.flatMap((claim) => claim.citations.filter((citation) => !input.sources[citation.sourceId]).map((citation) => citation.sourceId)),
      ),
    ];

    const deadRefs = [...deadSourceIds, ...deadEvidence];
    if (deadRefs.length) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'missing_source',
          pageIds: [page.id],
          key: [page.id, ...deadRefs],
          title: `${titleOf(page)} names sources that are gone`,
          detail: `Erased or never-kept: ${deadRefs.join(', ')}. The repair removes the dead references.`,
          evidence: deadRefs.map((id) => ({ pageId: page.id, note: `reference to ${id}` })),
          action: { kind: 'repair_page', pageId: page.id, repair: 'dead_source_refs' },
          revisions: revisionsFor([page.id]),
        }),
      );
    }
    if (deadCitations.length) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'missing_citation',
          pageIds: [page.id],
          key: [page.id, ...deadCitations],
          title: `${titleOf(page)} cites evidence that is gone`,
          detail: `Claims cite erased or never-kept sources: ${deadCitations.join(', ')}. The repair removes the dead citations; a claim left with no evidence is removed with them.`,
          evidence: deadCitations.map((id) => ({ pageId: page.id, note: `citation of ${id}` })),
          action: { kind: 'repair_page', pageId: page.id, repair: 'dead_source_refs' },
          revisions: revisionsFor([page.id]),
        }),
      );
    }
  }

  // -- link structure: dead links, unrecorded links, orphans ------------------------------
  for (const page of input.pages) {
    if (page.format !== 2 || !page.metadata || page.state !== 'ok') continue;
    const deadLinks = page.metadata.links.filter((link) => !liveIds.has(link.toPageId));
    if (deadLinks.length) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'dead_link',
          pageIds: [page.id],
          key: [page.id, ...deadLinks.map((link) => `${link.toPageId}:${link.type}`)],
          title: `${titleOf(page)} links to pages that do not exist`,
          detail: `Dead link${deadLinks.length === 1 ? '' : 's'}: ${deadLinks.map((link) => `${link.toPageId} (${link.type.replace('_', ' ')})`).join(', ')}.`,
          evidence: deadLinks.map((link) => ({ pageId: page.id, note: `${link.type.replace('_', ' ')} → ${link.toPageId}` })),
          action: { kind: 'repair_page', pageId: page.id, repair: 'dead_links' },
          revisions: revisionsFor([page.id]),
        }),
      );
    }

    const linked = new Set(page.metadata.links.map((link) => link.toPageId));
    for (const match of page.body.matchAll(BODY_LINK_PATTERN)) {
      const target = match[1]!;
      if (target === page.id || !liveIds.has(target) || linked.has(target)) continue;
      const targetTitle = titleOf(pages.get(target)!);
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'unrecorded_link',
          pageIds: [page.id, target],
          key: [page.id, target],
          title: `${titleOf(page)} mentions ${targetTitle} without a real link`,
          detail: `The body links [[${target}]] but the typed links do not record it, so the sky and the graph never see it.`,
          evidence: [{ pageId: page.id, note: `body mentions [[${target}]]` }],
          action: { kind: 'add_link', fromPageId: page.id, toPageId: target, linkType: 'related_to', why: 'The page body already links here.' },
          revisions: revisionsFor([page.id, target]),
        }),
      );
    }
  }

  for (const page of input.pages) {
    if (page.format === null) continue;
    const outbound = liveLinks(page).length;
    const inboundCount = (inbound.get(page.id) ?? []).filter((id) => liveIds.has(id)).length;
    if (outbound + inboundCount > 0) continue;
    const mapped = page.format === 2 && (page.metadata?.courseRefs.length ?? 0) > 0;
    findings.push(
      makeFinding({
        origin: 'deterministic',
        kind: 'orphan',
        pageIds: [page.id],
        key: [page.id],
        title: `${titleOf(page)} is an island`,
        detail: `No page links to it and it links nowhere${mapped ? ' — it is mapped to the course but not connected inside your wiki' : ''}.`,
        prompt: `How does ${titleOf(page)} relate to the other things on your map? What does it depend on, or contrast with?`,
        revisions: revisionsFor([page.id]),
      }),
    );
  }

  // -- the catalogue: unindexed pages and phantom index rows -------------------------------
  const indexRows = new Map<string, string | null>();
  for (const match of (input.indexText ?? '').matchAll(INDEX_ROW_PATTERN)) {
    indexRows.set(match[1]!, match[2]?.match(INDEX_REVISION_PATTERN)?.[0] ?? null);
  }
  for (const page of input.pages) {
    if (page.format === null) continue; // an unreadable page cannot be indexed; schema_issue already covers it
    const indexed = indexRows.get(page.id);
    if (indexed === undefined) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'unindexed',
          pageIds: [page.id],
          key: [page.id, 'missing'],
          title: `${titleOf(page)} is missing from the index`,
          detail: 'index.md does not list this page, so the catalogue understates the vault.',
          action: { kind: 'rebuild_catalogue' },
          revisions: revisionsFor([page.id]),
        }),
      );
    } else if (indexed !== null && indexed !== page.revision) {
      findings.push(
        makeFinding({
          origin: 'deterministic',
          kind: 'unindexed',
          pageIds: [page.id],
          key: [page.id, 'stale'],
          title: `The index is stale for ${titleOf(page)}`,
          detail: `index.md records ${indexed} but the page is at ${page.revision}.`,
          action: { kind: 'rebuild_catalogue' },
          revisions: revisionsFor([page.id]),
        }),
      );
    }
  }
  for (const [id] of indexRows) {
    if (liveIds.has(id)) continue;
    findings.push(
      makeFinding({
        origin: 'deterministic',
        kind: 'unindexed',
        pageIds: [],
        key: ['phantom', id],
        title: `The index lists a page that is gone: ${id}`,
        detail: 'index.md names a page file that does not exist in any kind folder.',
        action: { kind: 'rebuild_catalogue' },
        revisions: {},
      }),
    );
  }

  // -- course mapping ----------------------------------------------------------------------
  const courseIds = new Set(input.course.lessons.map((lesson) => lesson.courseId));
  for (const page of input.pages) {
    if (page.format !== 2 || !page.metadata || page.state !== 'ok' || page.kind !== 'concept') continue;
    const problems: string[] = [];
    let mapped = false;
    for (const ref of page.metadata.courseRefs) {
      const concept = input.course.concepts.get(ref.conceptKey);
      if (!concept) {
        problems.push(`${ref.conceptKey} is not a concept in any installed lesson`);
        continue;
      }
      if (ref.conceptKey === page.id) mapped = true;
      if (ref.courseId !== concept.introducedBy.courseId || (ref.lessonId && ref.lessonId !== concept.introducedBy.id)) {
        problems.push(`${ref.conceptKey} belongs to ${concept.introducedBy.courseId}, not ${ref.courseId}${ref.lessonId && ref.lessonId !== concept.introducedBy.id ? ` / ${ref.lessonId}` : ''}`);
      }
      if (!courseIds.has(ref.courseId)) problems.push(`course ${ref.courseId} is not installed`);
    }
    if (input.course.concepts.has(page.id) && !mapped) problems.push('the course concept this page is named for is not in its courseRefs');
    if (!problems.length) continue;
    findings.push(
      makeFinding({
        origin: 'deterministic',
        kind: 'bad_mapping',
        pageIds: [page.id],
        key: [page.id, ...problems],
        title: `${titleOf(page)}'s course mapping does not match the sky`,
        detail: `${problems.join('; ')}. The repair rewrites courseRefs from the course graph — code decides the mapping, never the model.`,
        evidence: [{ pageId: page.id, note: `${page.metadata.courseRefs.length} courseRef${page.metadata.courseRefs.length === 1 ? '' : 's'} recorded` }],
        action: { kind: 'repair_page', pageId: page.id, repair: 'course_mapping' },
        revisions: revisionsFor([page.id]),
      }),
    );
  }

  // -- size ----------------------------------------------------------------------------------
  for (const page of input.pages) {
    if (page.format === null || page.bytes <= OVERSIZED_PAGE_BYTES) continue;
    findings.push(
      makeFinding({
        origin: 'deterministic',
        kind: 'oversized',
        pageIds: [page.id],
        key: [page.id],
        title: `${titleOf(page)} is getting very long`,
        detail: `${Math.round(page.bytes / 1024)} KB — pages past ${OVERSIZED_PAGE_BYTES / 1024} KB usually want splitting into focused pages.`,
        prompt: `What are the two or three separate ideas inside ${titleOf(page)}?`,
        revisions: revisionsFor([page.id]),
      }),
    );
  }

  const order: Record<string, number> = {
    schema_issue: 0,
    revision_drift: 1,
    missing_source: 2,
    missing_citation: 2,
    dead_link: 3,
    unindexed: 4,
    bad_mapping: 5,
    unrecorded_link: 6,
    orphan: 7,
    oversized: 8,
  };
  return findings.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.id.localeCompare(b.id));
}
