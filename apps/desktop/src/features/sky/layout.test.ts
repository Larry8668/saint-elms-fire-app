import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONAL_SKY_ID, type GraphNode, type GraphResponse } from '@sef/shared';
import { layoutSky } from './layout';

const node = (id: string, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'concept',
  label: id,
  origin: 'course',
  courseId: 'mechanics',
  courseName: 'Classical Mechanics',
  subjectId: 'physics',
  semesterNumber: 1,
  status: 'met',
  misconceptions: 0,
  peer: false,
  ...overrides,
});

const lessonNode = (id: string): GraphNode => node(`l:${id}`, { kind: 'lesson', lessonId: id });
const personal = (id: string, kind: GraphNode['kind']): GraphNode =>
  node(id, { kind, origin: 'student', courseId: PERSONAL_SKY_ID, courseName: 'Your own sky', subjectId: PERSONAL_SKY_ID, semesterNumber: 0, pageId: id.split(':')[1] });

const graphOf = (nodes: GraphNode[]): GraphResponse => ({
  nodes,
  edges: [],
  stats: { courseConcepts: 2, lit: 2, shaky: 0, solid: 0, studentLinks: 0, personalPages: 0, collected: 0, demonstrated: 0 },
});

const COURSE_NODES = [lessonNode('lesson-1'), node('c:momentum'), node('c:force')];

test('personal pages land in their own constellation, never inside a course', () => {
  const layout = layoutSky(graphOf([...COURSE_NODES, personal('s:work-synthesis', 'synthesis'), personal('q:drag', 'question'), personal('c:greens', 'concept')]));

  const own = layout.constellations.find((c) => c.courseId === PERSONAL_SKY_ID);
  assert.ok(own, 'a personal constellation exists');
  assert.deepEqual(own.nodeIds.sort(), ['c:greens', 'q:drag', 's:work-synthesis'].sort());
  for (const id of own.nodeIds) {
    const [x, y] = layout.positions.get(id)!;
    assert.ok(x >= own.bounds.minX && x <= own.bounds.maxX && y >= own.bounds.minY && y <= own.bounds.maxY, `${id} sits inside its constellation`);
  }
  // Course constellations keep every one of their own nodes and take on none of ours.
  const course = layout.constellations.find((c) => c.courseId === 'mechanics')!;
  assert.deepEqual(course.nodeIds.sort(), COURSE_NODES.map((n) => n.id).sort());
});

test('adding the personal sky never moves a course star', () => {
  const before = layoutSky(graphOf(COURSE_NODES));
  const after = layoutSky(graphOf([...COURSE_NODES, personal('q:drag', 'question')]));
  for (const n of COURSE_NODES) {
    assert.deepEqual(after.positions.get(n.id), before.positions.get(n.id), `${n.id} did not move`);
  }
});

test('an empty personal sky draws no constellation at all', () => {
  const layout = layoutSky(graphOf(COURSE_NODES));
  assert.equal(layout.constellations.find((c) => c.courseId === PERSONAL_SKY_ID), undefined);
});

test('the layout is deterministic — same nodes, same sky', () => {
  const nodes = [...COURSE_NODES, personal('s:a', 'synthesis'), personal('q:b', 'question')];
  const a = layoutSky(graphOf(nodes));
  const b = layoutSky(graphOf(nodes));
  for (const n of nodes) assert.deepEqual(a.positions.get(n.id), b.positions.get(n.id));
});
