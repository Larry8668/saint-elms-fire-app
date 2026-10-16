import { ExplorationAnchorSchema, teacherPolicy, type AnchorCandidate, type ExplorationAnchor, type TeacherId } from '@sef/shared';

/**
 * An anchor has to be a concept this student has actually committed to their own wiki, at a
 * revision the vault still holds. A released syllabus concept is not an anchor: it is courseware
 * the Philosopher can read anyway, and anchoring to it would let the teacher wander from nothing.
 */
export interface AnchorTarget {
  pageId: string;
  revision: string;
  courseConceptKey: string;
  courseRefs: string[];
}

export interface AnchorRequest {
  teacher: TeacherId;
  /** Page the client asked to explore from. Unverified until resolved. */
  anchorPageId?: string;
  /** The revision the client believes it is anchoring to. A mismatch is a stale anchor. */
  claimedRevision?: string;
  /** A released syllabus concept offered as a starting point. Never an anchor on its own. */
  syllabusConceptKey?: string;
  /** Committed pages of the active student's own wiki, keyed by page id. */
  committed: Map<string, AnchorTarget>;
}

export type AnchorResolution =
  | {
      ok: true;
      anchor: ExplorationAnchor;
      courseRefs: string[];
      /** The catalogue row behind the anchor — present when the resolver read a real page, so the turn can record and display it. */
      candidate?: AnchorCandidate;
    }
  | { ok: false; reason: AnchorFailure };

export type AnchorFailure = 'no_anchor' | 'syllabus_concept_not_an_anchor' | 'uncommitted_page' | 'stale_revision' | 'not_a_course_concept';

export const ANCHOR_FAILURE_COPY: Record<AnchorFailure, string> = {
  no_anchor: 'No exploration anchor. The Philosopher starts from a concept already committed to your own wiki, and there is none to start from yet.',
  syllabus_concept_not_an_anchor: 'A released syllabus concept is not an anchor. Pick a concept from your own wiki.',
  uncommitted_page: 'That page is not committed to your wiki.',
  stale_revision: 'That page changed since it was chosen. Open it again to anchor a current revision.',
  not_a_course_concept: 'That page is not linked to a course concept, so there is nothing to explore outward from.',
};

export interface AnchorResolver {
  resolve(request: AnchorRequest): Promise<AnchorResolution>;
}

/**
 * Resolves an anchor only from committed, course-linked pages in this student's wiki. Anything
 * else fails with a named reason rather than degrading into a generic answer.
 */
export const committedPageAnchors: AnchorResolver = {
  async resolve(request) {
    const pageId = request.anchorPageId;
    if (!pageId) return { ok: false, reason: request.syllabusConceptKey ? 'syllabus_concept_not_an_anchor' : 'no_anchor' };
    const page = request.committed.get(pageId);
    if (!page) return { ok: false, reason: 'uncommitted_page' };
    if (!page.courseConceptKey || !page.courseRefs.length) return { ok: false, reason: 'not_a_course_concept' };
    if (request.claimedRevision && request.claimedRevision !== page.revision) return { ok: false, reason: 'stale_revision' };
    return {
      ok: true,
      anchor: { pageId, pageRevision: page.revision, courseConceptKey: page.courseConceptKey, courseRefs: page.courseRefs },
      courseRefs: page.courseRefs,
    };
  },
};

/**
 * Until the personal-wiki anchor exists (PR-21) there is nothing that can resolve one, so the
 * seam refuses every Philosopher turn. Failing closed is the point: a teacher that cannot prove
 * its starting point says so instead of inventing one.
 */
export const unresolvableAnchors: AnchorResolver = {
  async resolve(request) {
    if (request.syllabusConceptKey) return { ok: false, reason: 'syllabus_concept_not_an_anchor' };
    return { ok: false, reason: 'no_anchor' };
  },
};

export function requiresAnchor(teacher: TeacherId): boolean {
  return teacherPolicy(teacher).anchor !== 'none';
}

/** Guards an anchor that arrived from outside the resolver, e.g. replayed over the wire. */
export function assertWellFormedAnchor(anchor: ExplorationAnchor, page: AnchorTarget | undefined): AnchorFailure | null {
  if (!ExplorationAnchorSchema.safeParse(anchor).success) return 'no_anchor';
  if (!page) return 'uncommitted_page';
  if (page.revision !== anchor.pageRevision) return 'stale_revision';
  if (page.courseConceptKey !== anchor.courseConceptKey) return 'not_a_course_concept';
  return null;
}