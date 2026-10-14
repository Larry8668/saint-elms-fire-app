import { conceptKey, conceptLabel, type EdgeType, type Lesson } from '@sef/shared';

export interface CourseConcept {
  key: string;
  label: string;
  introducedBy: Lesson;
  mentions: Lesson[];
}

export interface CourseEdge {
  source: string;
  target: string;
  type: EdgeType;
  why: string;
}

export interface CourseGraph {
  lessons: Lesson[];
  concepts: Map<string, CourseConcept>;
  edges: CourseEdge[];
}

export const lessonNodeId = (lessonId: string) => `l:${lessonId}`;
export const conceptNodeId = (key: string) => `c:${key}`;

/**
 * The course sky, built deterministically from lesson frontmatter. Identical for
 * every student with the same releases; the brain is drawn on top of it.
 */
export function buildCourseGraph(lessons: Lesson[]): CourseGraph {
  const concepts = new Map<string, CourseConcept>();
  for (const lesson of lessons) {
    for (const raw of lesson.concepts) {
      const key = conceptKey(raw);
      if (!key) continue;
      const existing = concepts.get(key);
      if (existing) {
        if (!existing.mentions.includes(lesson)) existing.mentions.push(lesson);
      } else {
        concepts.set(key, { key, label: conceptLabel(raw), introducedBy: lesson, mentions: [lesson] });
      }
    }
  }

  const edges: CourseEdge[] = [];
  const seen = new Set<string>();
  const link = (source: string, target: string, type: EdgeType, why: string) => {
    const id = `${source}>${target}`;
    if (source === target || seen.has(id)) return;
    seen.add(id);
    edges.push({ source, target, type, why });
  };

  for (const concept of concepts.values()) {
    link(conceptNodeId(concept.key), lessonNodeId(concept.introducedBy.id), 'part_of', `Introduced in ${concept.introducedBy.title}`);
    for (const later of concept.mentions.slice(1)) {
      link(lessonNodeId(later.id), conceptNodeId(concept.key), 'builds_upon', `${later.title} revisits ${concept.label}`);
    }
  }

  const ids = new Set(lessons.map((l) => l.id));
  for (const lesson of lessons) {
    for (const required of lesson.prerequisites) {
      if (ids.has(required)) link(lessonNodeId(required), lessonNodeId(lesson.id), 'prerequisite', `Needed before ${lesson.title}`);
    }
  }

  return { lessons, concepts, edges };
}
