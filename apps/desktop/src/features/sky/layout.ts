import type { GraphEdge, GraphNode, GraphResponse } from '@sef/shared';

export type Vec2 = [number, number];

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Constellation {
  courseId: string;
  title: string;
  subjectId: string;
  semesterNumber: number;
  bounds: Bounds;
  /** Lesson positions in teaching order: the figure drawn between them. */
  path: Vec2[];
  nodeIds: string[];
}

export interface SemesterColumn {
  semesterNumber: number;
  x: number;
  top: number;
}

export interface SkyLayout {
  positions: Map<string, Vec2>;
  constellations: Constellation[];
  semesters: SemesterColumn[];
  neighbours: Map<string, Set<string>>;
  bounds: Bounds;
}

/** World units are screen pixels at zoom 1. */
const LESSON_GAP = 120;
const COURSE_PAD = 70;
const COURSE_GAP_Y = 150;
const SEMESTER_GAP_X = 260;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const byNaturalId = (a: GraphNode, b: GraphNode) => (a.lessonId ?? a.id).localeCompare(b.lessonId ?? b.id, undefined, { numeric: true });

export const emptyBounds = (): Bounds => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

export function growBounds(b: Bounds, [x, y]: Vec2, pad = 0): Bounds {
  b.minX = Math.min(b.minX, x - pad);
  b.maxX = Math.max(b.maxX, x + pad);
  b.minY = Math.min(b.minY, y - pad);
  b.maxY = Math.max(b.maxY, y + pad);
  return b;
}

export const boundsCenter = (b: Bounds): Vec2 => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/** Lays one course out around the origin: lessons along a gentle wave, concepts spiralling around their lesson. */
function layoutCourse(nodes: GraphNode[]) {
  const local = new Map<string, Vec2>();
  const lessons = nodes.filter((n) => n.kind === 'lesson').sort(byNaturalId);
  const phase = hash01(nodes[0]!.courseId) * Math.PI * 2;
  const conceptsByLesson = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.kind !== 'concept' || !n.lessonId) continue;
    conceptsByLesson.set(n.lessonId, [...(conceptsByLesson.get(n.lessonId) ?? []), n]);
  }

  const path: Vec2[] = [];
  lessons.forEach((lesson, i) => {
    const p: Vec2 = [i * LESSON_GAP, Math.sin(i * 0.95 + phase) * 48 + Math.sin(i * 2.3 + phase * 2) * 14];
    local.set(lesson.id, p);
    path.push(p);
    (conceptsByLesson.get(lesson.lessonId ?? '') ?? []).forEach((concept, k) => {
      const angle = k * GOLDEN_ANGLE + phase;
      const r = 30 + Math.sqrt(k) * 15;
      local.set(concept.id, [p[0] + Math.cos(angle) * r, p[1] + Math.sin(angle) * r]);
    });
  });

  const span = Math.max(1, lessons.length - 1) * LESSON_GAP;
  for (const n of nodes) {
    if (local.has(n.id)) continue;
    const a = hash01(n.id) * Math.PI * 2;
    local.set(n.id, [span / 2 + Math.cos(a) * span * 0.4, Math.sin(a) * 60]);
  }

  const bounds = emptyBounds();
  for (const p of local.values()) growBounds(bounds, p, COURSE_PAD);
  return { local, path, bounds };
}

/**
 * Deterministic star-chart layout. Reading left to right is reading the programme:
 * one column per semester, one constellation per course, lessons in teaching order.
 */
export function layoutSky(graph: GraphResponse): SkyLayout {
  const byCourse = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) byCourse.set(node.courseId, [...(byCourse.get(node.courseId) ?? []), node]);

  const bySemester = new Map<number, GraphNode[][]>();
  for (const nodes of byCourse.values()) {
    const sem = nodes[0]!.semesterNumber;
    bySemester.set(sem, [...(bySemester.get(sem) ?? []), nodes]);
  }

  const positions = new Map<string, Vec2>();
  const constellations: Constellation[] = [];
  const semesters: SemesterColumn[] = [];
  let columnX = 0;

  for (const sem of [...bySemester.keys()].sort((a, b) => a - b)) {
    const courses = bySemester.get(sem)!.sort((a, b) => a[0]!.courseName.localeCompare(b[0]!.courseName)).map(layoutCourse);
    const columnWidth = Math.max(...courses.map((c) => c.bounds.maxX - c.bounds.minX));
    let cursorY = 0;
    semesters.push({ semesterNumber: sem, x: columnX, top: 0 });

    courses.forEach((course, i) => {
      const nodes = bySemester.get(sem)![i]!;
      const dx = columnX - course.bounds.minX;
      const dy = cursorY - course.bounds.maxY;
      const shift = ([x, y]: Vec2): Vec2 => [x + dx, y + dy];
      for (const [id, p] of course.local) positions.set(id, shift(p));
      constellations.push({
        courseId: nodes[0]!.courseId,
        title: nodes[0]!.courseName,
        subjectId: nodes[0]!.subjectId,
        semesterNumber: sem,
        bounds: { minX: course.bounds.minX + dx, maxX: course.bounds.maxX + dx, minY: course.bounds.minY + dy, maxY: course.bounds.maxY + dy },
        path: course.path.map(shift),
        nodeIds: nodes.map((n) => n.id),
      });
      cursorY -= course.bounds.maxY - course.bounds.minY + COURSE_GAP_Y;
    });
    columnX += columnWidth + SEMESTER_GAP_X;
  }

  const bounds = emptyBounds();
  for (const c of constellations) {
    growBounds(bounds, [c.bounds.minX, c.bounds.minY]);
    growBounds(bounds, [c.bounds.maxX, c.bounds.maxY]);
  }
  return { positions, constellations, semesters, neighbours: neighbourMap(graph.edges), bounds };
}

function neighbourMap(edges: GraphEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string) => map.set(a, (map.get(a) ?? new Set<string>()).add(b));
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  return map;
}
