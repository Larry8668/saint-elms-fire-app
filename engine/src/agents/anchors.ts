import { conceptKey, type AnchorCandidate, type ConceptPage } from '@sef/shared';
import type { CourseGraph } from '../brain/course-graph';
import { computeStatus } from '../brain/mastery';
import type { WikiReader } from '../brain/query';
import { legacyPageSummary } from '../brain/wiki-page-format';
import type { PageSnapshot } from '../brain/wiki-store';
import type { BrainVault } from '../brain/vault';
import { committedPageAnchors, type AnchorResolver, type AnchorTarget } from './anchor';

/**
 * The profile-backed anchor seam. `anchor.ts` decides what counts; this file proves it
 * against the signed-in student's own vault, read fresh from disk on every call — a page
 * id, revision or concept key offered over the wire is only ever an input to that check.
 *
 * Eligibility is deliberately strict: a page must be a concept page in committed standing
 * that still maps to a concept the student's released courseware teaches. A generated page
 * (synthesis, source summary, question) is context, not an origin; a pending proposal is
 * not yet a page; a peer share is not this student's wiki until it lands through the same
 * committed path; a file that drifted out of band is no longer the committed page it was.
 */
export interface AnchorContext {
  wiki: Pick<WikiReader, 'listPages' | 'readPage'>;
  vault: Pick<BrainVault, 'all' | 'conceptView'>;
  graph: CourseGraph;
  programmeId: string;
}

interface CourseLink {
  conceptKey: string;
  courseIds: string[];
}

/** The released courses that actually teach this concept — never an empty list. */
function teachingCourses(graph: CourseGraph, key: string): Set<string> | null {
  const concept = graph.concepts.get(key);
  return concept ? new Set(concept.mentions.map((lesson) => lesson.courseId)) : null;
}

/**
 * The verified course link of a committed concept page: the concept it maps to, and the
 * course ids it claims that genuinely teach that concept here. A typed page's courseRefs
 * carry programme scope; a legacy or migrated page carries its course ids verbatim, so the
 * page id — its concept key — must still be a released course concept whose teaching
 * courses overlap the ones the page declares.
 */
function courseLinkOf(snapshot: PageSnapshot, ctx: AnchorContext): CourseLink | null {
  if (snapshot.kind !== 'concept') return null;
  const metadata = snapshot.metadata;
  if (metadata) {
    const refs = metadata.courseRefs.filter(
      (ref) => ref.programmeId === ctx.programmeId && teachingCourses(ctx.graph, ref.conceptKey)?.has(ref.courseId),
    );
    if (refs.length) {
      return { conceptKey: refs[0]!.conceptKey, courseIds: [...new Set(refs.map((ref) => ref.courseId))] };
    }
    // A migrated legacy page keeps its original course ids under provenance.
    const legacyIds = new Set(metadata.provenance?.legacyCourseRefs ?? []);
    const teaching = teachingCourses(ctx.graph, snapshot.id);
    const verified = [...legacyIds].filter((courseId) => teaching?.has(courseId));
    return verified.length ? { conceptKey: snapshot.id, courseIds: verified } : null;
  }
  const legacy = snapshot.legacy;
  if (!legacy) return null;
  const teaching = teachingCourses(ctx.graph, snapshot.id);
  const verified = legacy.courseRefs.filter((courseId) => teaching?.has(courseId));
  return verified.length ? { conceptKey: snapshot.id, courseIds: verified } : null;
}

/**
 * One page judged as an anchor target. `null` means "no committed page by this id" — the
 * file is missing, malformed, from a newer schema or drifted out of band. A readable page
 * that is not a course-linked concept returns a target with no concept, so the seam can
 * say `not_a_course_concept` rather than pretending the page was never there.
 */
export function anchorTargetOf(snapshot: PageSnapshot | null, ctx: AnchorContext): AnchorTarget | null {
  if (!snapshot || snapshot.state !== 'ok') return null;
  const link = courseLinkOf(snapshot, ctx);
  return {
    pageId: snapshot.id,
    revision: snapshot.revision,
    courseConceptKey: link?.conceptKey ?? '',
    courseRefs: link?.courseIds ?? [],
  };
}

function isoOrNull(value: string | undefined | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** The catalogue row for one eligible page — the anchor contract plus what a picker shows. */
function anchorCandidateOf(snapshot: PageSnapshot, view: ConceptPage | null, link: CourseLink, ctx: AnchorContext): AnchorCandidate {
  const metadata = snapshot.metadata;
  const concept = ctx.graph.concepts.get(link.conceptKey);
  const title = metadata?.title ?? snapshot.legacy?.concept ?? snapshot.id;
  return {
    pageId: snapshot.id,
    pageRevision: snapshot.revision,
    courseConceptKey: link.conceptKey,
    courseRefs: link.courseIds,
    title,
    summary: metadata?.summary ?? (snapshot.legacy ? legacyPageSummary(snapshot.legacy) : title),
    status: computeStatus(view),
    courseName: concept?.mentions.find((lesson) => lesson.courseId === link.courseIds[0])?.courseName ?? link.courseIds[0] ?? '',
    conceptLabel: concept?.label ?? title,
    updatedAt: isoOrNull(metadata?.updatedAt ?? snapshot.legacy?.updated),
  };
}

/**
 * Every committed, course-linked concept page in this student's wiki, freshest first.
 * Concept views come from the vault so status is computed from resolved evidence exactly
 * as the sky shows it — a shaky page stays a valid anchor; mastery never gates exploration.
 */
export async function anchorCatalog(ctx: AnchorContext): Promise<AnchorCandidate[]> {
  const [snapshots, pages] = await Promise.all([ctx.wiki.listPages(), ctx.vault.all()]);
  const anchors: AnchorCandidate[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.state !== 'ok' || snapshot.kind !== 'concept') continue;
    const link = courseLinkOf(snapshot, ctx);
    if (!link) continue;
    anchors.push(anchorCandidateOf(snapshot, pages.get(snapshot.id) ?? null, link, ctx));
  }
  return anchors.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.title.localeCompare(b.title));
}

const tokenize = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export interface AnchorMatch {
  outcome: 'resolved' | 'ambiguous' | 'none';
  anchors: AnchorCandidate[];
}

/**
 * Free text against the catalogue. A candidate matches only when it covers every query
 * term across its title, page id, concept key and the course's own label — a single match
 * resolves, several return the list for the student to choose, and a partial hint matches
 * nothing rather than silently guessing a page.
 */
export function matchAnchorPages(candidates: AnchorCandidate[], query: string): AnchorMatch {
  const terms = tokenize(query);
  if (!terms.length) return { outcome: 'none', anchors: [] };
  const key = conceptKey(query);
  const matches = candidates.filter((candidate) => {
    if (key && (candidate.pageId === key || candidate.courseConceptKey === key)) return true;
    const words = new Set(tokenize(`${candidate.title} ${candidate.pageId} ${candidate.courseConceptKey} ${candidate.conceptLabel} ${candidate.courseName}`));
    return terms.every((term) => words.has(term));
  });
  if (!matches.length) return { outcome: 'none', anchors: [] };
  return { outcome: matches.length === 1 ? 'resolved' : 'ambiguous', anchors: matches };
}

/** The topic-only web query: the released course's name for the anchored concept, never chat text. */
export function anchorTopic(candidate: AnchorCandidate | null, fallback = ''): string {
  return candidate?.conceptLabel ?? fallback;
}

async function candidateFor(ctx: AnchorContext, snapshot: PageSnapshot, link: CourseLink): Promise<AnchorCandidate> {
  const view = snapshot.legacy ?? (snapshot.metadata ? await ctx.vault.conceptView(snapshot.metadata, snapshot.body).catch(() => null) : null);
  return anchorCandidateOf(snapshot, view, link, ctx);
}

/**
 * The real resolver behind the Philosopher: the student's own vault is re-read on every
 * turn and the pure seam (`committedPageAnchors`) still decides pass/fail on the result.
 * A `syllabusConceptKey` resolves to this student's own committed page for that concept —
 * never to the released concept itself.
 */
export function profileAnchors(ctx: AnchorContext): AnchorResolver {
  return {
    async resolve(request) {
      let pageId = request.anchorPageId;
      if (!pageId && request.syllabusConceptKey) {
        const [snapshots] = await Promise.all([ctx.wiki.listPages()]);
        pageId = snapshots
          .filter((snapshot) => snapshot.state === 'ok')
          .map((snapshot) => ({ snapshot, link: courseLinkOf(snapshot, ctx) }))
          .filter((entry): entry is { snapshot: PageSnapshot; link: CourseLink } => Boolean(entry.link))
          .filter((entry) => entry.link.conceptKey === request.syllabusConceptKey)
          .map((entry) => entry.snapshot.id)
          .sort()[0];
      }
      if (!pageId) return committedPageAnchors.resolve({ ...request, committed: new Map() });
      const snapshot = await ctx.wiki.readPage(pageId);
      const target = anchorTargetOf(snapshot, ctx);
      const committed = target ? new Map([[pageId, target]]) : new Map<string, AnchorTarget>();
      const resolution = await committedPageAnchors.resolve({ ...request, anchorPageId: pageId, committed });
      if (resolution.ok && snapshot) {
        const link = courseLinkOf(snapshot, ctx);
        if (link) resolution.candidate = await candidateFor(ctx, snapshot, link);
      }
      return resolution;
    },
  };
}
