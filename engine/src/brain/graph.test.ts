import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONAL_SKY_ID, type Lesson } from '@sef/shared';
import type { InstalledCourse } from '../content/store';
import { buildCourseGraph } from './course-graph';
import { buildGraphView, type BrainGraphPage } from './graph';
import { legacyPage } from './testing/fixtures';

const lesson = (id: string, concepts: string[], order = 0): Lesson => ({
  id,
  courseId: 'mechanics',
  courseName: 'Classical Mechanics',
  moduleId: 'mech-m1',
  moduleName: 'Foundations',
  subjectId: 'physics',
  semesterNumber: 1,
  order,
  title: `Lesson ${id}`,
  concepts,
  prerequisites: [],
  tags: [],
  markdown: '',
});

const COURSES: Record<string, InstalledCourse> = {
  mechanics: { id: 'mechanics', title: 'Classical Mechanics', subjectId: 'physics', semesterNumber: 1, lessonCount: 2, version: 'v1', support: false, installedAt: '2026-10-01T00:00:00.000Z' },
};

const page = (id: string, kind: BrainGraphPage['kind'], overrides: Partial<BrainGraphPage> = {}): BrainGraphPage => ({
  id,
  kind,
  title: id,
  updatedAt: '2026-10-15T00:00:00.000Z',
  links: [],
  origin: 'student',
  view: null,
  collected: 0,
  demonstrated: 0,
  ...overrides,
});

const lessons = [lesson('lesson-1', ['Momentum', 'Force']), lesson('lesson-2', ['Energy'], 1)];

test('the course sky is untouched: lessons and concepts keep their stable ids', () => {
  const graph = buildGraphView(buildCourseGraph(lessons), [], COURSES);
  assert.deepEqual(
    graph.nodes.map((n) => n.id).sort(),
    ['c:energy', 'c:force', 'c:momentum', 'l:lesson-1', 'l:lesson-2'],
  );
  assert.ok(graph.nodes.every((n) => n.origin === 'course'));
  assert.equal(graph.stats.personalPages, 0);
});

test('a course concept with a brain page stays a course star and carries its page anchor', () => {
  const view = legacyPage('momentum');
  const graph = buildGraphView(buildCourseGraph(lessons), [page('momentum', 'concept', { view, title: 'Momentum' })], COURSES);
  const node = graph.nodes.find((n) => n.id === 'c:momentum');
  assert.equal(node?.origin, 'course');
  assert.equal(node?.courseId, 'mechanics');
  assert.equal(node?.pageId, 'momentum');
  assert.equal(node?.lessonId, 'lesson-1');
  assert.notEqual(node?.status, 'unseen', 'a page exists, so the star is lit');
});

test('personal concepts, syntheses and questions become their own stars off the syllabus', () => {
  const pages = [
    page('green-s-functions', 'concept', { title: "Green's functions", view: legacyPage('green-s-functions'), demonstrated: 1 }),
    page('work-synthesis', 'synthesis', { title: 'Work is the integral of force', demonstrated: 2 }),
    page('drag-question', 'question', { title: 'Does energy survive drag?', collected: 1 }),
    page('note-summary', 'source_summary', { title: 'A kept note' }),
  ];
  const graph = buildGraphView(buildCourseGraph(lessons), pages, COURSES);

  const personal = graph.nodes.filter((n) => n.origin !== 'course');
  assert.deepEqual(
    personal.map((n) => [n.id, n.kind]).sort(),
    [
      ['c:green-s-functions', 'concept'],
      ['q:drag-question', 'question'],
      ['s:work-synthesis', 'synthesis'],
    ],
  );
  for (const node of personal) {
    assert.equal(node.courseId, PERSONAL_SKY_ID);
    assert.equal(node.lessonId, undefined, 'no fabricated introducing lesson — nothing to quiz');
    assert.equal(node.pageId, node.id.split(':')[1]);
  }
  assert.equal(graph.nodes.find((n) => n.id === 'note-summary'), undefined, 'a kept source is a record, not a star');
  assert.equal(graph.stats.personalPages, 3);
  assert.equal(graph.stats.demonstrated, 3);
  assert.equal(graph.stats.collected, 1);
});

test('a page imported from a peer share keeps its peer provenance on the node', () => {
  const graph = buildGraphView(buildCourseGraph(lessons), [page('green-s-functions', 'concept', { origin: 'peer', view: legacyPage('green-s-functions') })], COURSES);
  const node = graph.nodes.find((n) => n.id === 'c:green-s-functions');
  assert.equal(node?.origin, 'peer');
  assert.equal(node?.peer, true);
});

test('links from personal pages reach course stars; links to nowhere are dropped', () => {
  const pages = [
    page('work-synthesis', 'synthesis', {
      links: [
        { toPageId: 'work', type: 'related_to', origin: 'student', why: 'Same machine' },
        { toPageId: 'not-a-page', type: 'related_to', origin: 'student', why: 'Gone' },
      ],
    }),
    page('work', 'concept', { view: legacyPage('work') }),
  ];
  // 'work' is not a course concept here — it is a personal page, so the link should target its own node id.
  const graph = buildGraphView(buildCourseGraph(lessons), pages, COURSES);
  const edge = graph.edges.find((e) => e.source === 's:work-synthesis');
  assert.equal(edge?.target, 'c:work');
  assert.equal(edge?.origin, 'student');
  assert.equal(graph.edges.filter((e) => e.source === 's:work-synthesis').length, 1, 'the dead link is dropped');
  assert.equal(graph.stats.studentLinks, 1);
});

test('a concept page that IS a course concept never duplicates the course star', () => {
  const graph = buildGraphView(buildCourseGraph(lessons), [page('momentum', 'concept', { view: legacyPage('momentum') })], COURSES);
  assert.equal(graph.nodes.filter((n) => n.id === 'c:momentum').length, 1);
  assert.equal(graph.nodes.filter((n) => n.origin !== 'course').length, 0);
});
