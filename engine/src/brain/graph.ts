import {
  pageNodeId,
  PERSONAL_SKY_ID,
  PERSONAL_SKY_TITLE,
  SKY_PAGE_KINDS,
  type ConceptPage,
  type EdgeOrigin,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type GraphResponse,
  type SkyPageKind,
} from '@sef/shared';
import type { InstalledCourse } from '../content/store';
import { conceptNodeId, lessonNodeId, type CourseGraph } from './course-graph';
import { computeStatus } from './mastery';

/** A vault page as the graph needs it — the concept view for concept kind, links for all sky kinds. */
export interface BrainGraphPage {
  id: string;
  kind: SkyPageKind | 'source_summary';
  title: string;
  updatedAt: string;
  links: Array<{ toPageId: string; type: EdgeType; origin: EdgeOrigin; why?: string }>;
  /** Page provenance: 'peer' only when an accepted peer share is its whole story. */
  origin: 'student' | 'peer';
  /** The resolved concept view (evidence, misconceptions) — concept kind only. */
  view: ConceptPage | null;
  /** Growth events counted for this page: collected material vs demonstrated understanding. */
  collected: number;
  demonstrated: number;
}

const isSkyKind = (kind: string): kind is SkyPageKind => (SKY_PAGE_KINDS as readonly string[]).includes(kind);

/**
 * Merges the shared course sky with this student's brain into one drawable graph. Course stars
 * keep their ids and constellation; every sky-shaped vault page — personal concepts, syntheses,
 * open questions — becomes a node in the personal sky, with its links drawn to whatever it
 * connects, on the syllabus or off it. Links to pages that do not exist are still dropped.
 */
export function buildGraphView(course: CourseGraph, pages: BrainGraphPage[], courses: Record<string, InstalledCourse>): GraphResponse {
  const nodes: GraphNode[] = [];
  const courseName = (id: string) => (id === PERSONAL_SKY_ID ? PERSONAL_SKY_TITLE : (courses[id]?.title ?? id));
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const viewByKey = new Map(pages.flatMap((page) => (page.view ? [[page.id, page.view]] as const : [])));

  for (const lesson of course.lessons) {
    nodes.push({
      id: lessonNodeId(lesson.id),
      kind: 'lesson',
      label: lesson.title,
      origin: 'course',
      courseId: lesson.courseId,
      courseName: courseName(lesson.courseId),
      subjectId: lesson.subjectId,
      semesterNumber: lesson.semesterNumber,
      lessonId: lesson.id,
      status: 'unseen',
      misconceptions: 0,
      peer: false,
    });
  }

  for (const concept of course.concepts.values()) {
    const page = viewByKey.get(concept.key);
    nodes.push({
      id: conceptNodeId(concept.key),
      kind: 'concept',
      label: page?.concept ?? concept.label,
      origin: 'course',
      courseId: concept.introducedBy.courseId,
      courseName: courseName(concept.introducedBy.courseId),
      subjectId: concept.introducedBy.subjectId,
      semesterNumber: concept.introducedBy.semesterNumber,
      lessonId: concept.introducedBy.id,
      key: concept.key,
      pageId: pageById.has(concept.key) ? concept.key : undefined,
      updated: page?.updated,
      status: computeStatus(page ?? null),
      misconceptions: page?.misconceptions.filter((m) => !m.resolved).length ?? 0,
      peer: page?.links.some((l) => l.origin === 'peer') ?? false,
      collected: pageById.get(concept.key)?.collected ?? 0,
      demonstrated: pageById.get(concept.key)?.demonstrated ?? 0,
    });
  }

  // Personal sky: concept pages with no introducing lesson, plus synthesis and question pages.
  for (const page of pages) {
    if (!isSkyKind(page.kind)) continue;
    if (page.kind === 'concept' && course.concepts.has(page.id)) continue;
    nodes.push({
      id: pageNodeId(page.kind, page.id),
      kind: page.kind,
      label: page.title,
      origin: page.origin,
      courseId: PERSONAL_SKY_ID,
      courseName: PERSONAL_SKY_TITLE,
      subjectId: PERSONAL_SKY_ID,
      semesterNumber: 0,
      ...(page.kind === 'concept' ? { key: page.id } : {}),
      pageId: page.id,
      updated: page.updatedAt,
      status: page.view ? computeStatus(page.view) : 'met',
      misconceptions: page.view?.misconceptions.filter((m) => !m.resolved).length ?? 0,
      peer: page.origin === 'peer' || page.links.some((l) => l.origin === 'peer'),
      collected: page.collected,
      demonstrated: page.demonstrated,
    });
  }

  const edges: GraphEdge[] = course.edges.map((e) => ({
    id: `${e.source}>${e.target}`,
    source: e.source,
    target: e.target,
    type: e.type,
    origin: 'course',
    why: e.why,
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));
  const seen = new Set(edges.map((e) => e.id));
  let studentLinks = 0;
  for (const page of pages) {
    if (!isSkyKind(page.kind)) continue;
    const source = pageNodeId(page.kind, page.id);
    if (!nodeIds.has(source)) continue;
    for (const link of page.links) {
      const targetPage = pageById.get(link.toPageId);
      const target = targetPage && isSkyKind(targetPage.kind) ? pageNodeId(targetPage.kind, targetPage.id) : conceptNodeId(link.toPageId);
      if (!nodeIds.has(target)) continue;
      const id = `${source}>${target}:${link.origin}:${link.type}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source, target, type: link.type, origin: link.origin, why: link.why });
      if (link.origin === 'student') studentLinks += 1;
    }
  }

  const conceptNodes = nodes.filter((n) => n.kind === 'concept');
  return {
    nodes,
    edges,
    stats: {
      courseConcepts: conceptNodes.filter((n) => n.origin === 'course').length,
      lit: conceptNodes.filter((n) => n.origin === 'course' && n.status !== 'unseen').length,
      shaky: conceptNodes.filter((n) => n.status === 'shaky').length,
      solid: conceptNodes.filter((n) => n.status === 'solid').length,
      studentLinks,
      personalPages: nodes.filter((n) => n.origin !== 'course').length,
      collected: pages.reduce((sum, page) => sum + page.collected, 0),
      demonstrated: pages.reduce((sum, page) => sum + page.demonstrated, 0),
    },
  };
}
