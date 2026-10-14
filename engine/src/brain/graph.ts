import type { ConceptPage, GraphEdge, GraphNode, GraphResponse } from '@sef/shared';
import type { InstalledCourse } from '../content/store';
import { conceptNodeId, lessonNodeId, type CourseGraph } from './course-graph';
import { computeStatus } from './mastery';

/** Merges the shared course sky with this student's brain into one drawable graph. */
export function buildGraphView(
  course: CourseGraph,
  pages: Map<string, ConceptPage>,
  courses: Record<string, InstalledCourse>,
): GraphResponse {
  const nodes: GraphNode[] = [];
  const courseName = (id: string) => courses[id]?.title ?? id;

  for (const lesson of course.lessons) {
    nodes.push({
      id: lessonNodeId(lesson.id),
      kind: 'lesson',
      label: lesson.title,
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
    const page = pages.get(concept.key);
    nodes.push({
      id: conceptNodeId(concept.key),
      kind: 'concept',
      label: page?.concept ?? concept.label,
      courseId: concept.introducedBy.courseId,
      courseName: courseName(concept.introducedBy.courseId),
      subjectId: concept.introducedBy.subjectId,
      semesterNumber: concept.introducedBy.semesterNumber,
      lessonId: concept.introducedBy.id,
      key: concept.key,
      status: computeStatus(page ?? null),
      misconceptions: page?.misconceptions.filter((m) => !m.resolved).length ?? 0,
      peer: page?.links.some((l) => l.origin === 'peer') ?? false,
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
  let studentLinks = 0;
  for (const page of pages.values()) {
    for (const link of page.links) {
      const source = conceptNodeId(page.key);
      const target = conceptNodeId(link.to);
      if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
      edges.push({ id: `${source}>${target}:${link.origin}`, source, target, type: link.type, origin: link.origin, why: link.why });
      if (link.origin === 'student') studentLinks += 1;
    }
  }

  const conceptNodes = nodes.filter((n) => n.kind === 'concept');
  return {
    nodes,
    edges,
    stats: {
      courseConcepts: conceptNodes.length,
      lit: conceptNodes.filter((n) => n.status !== 'unseen').length,
      shaky: conceptNodes.filter((n) => n.status === 'shaky').length,
      solid: conceptNodes.filter((n) => n.status === 'solid').length,
      studentLinks,
    },
  };
}
