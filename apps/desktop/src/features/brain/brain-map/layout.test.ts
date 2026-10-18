import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONAL_SKY_ID, type GraphNode, type GraphResponse, type PageRecordSummary, type WikiGraph } from '@sef/shared';
import { buildBrainMap, describeBrainMap } from './layout';

const rec = (id: string, over: Partial<PageRecordSummary> = {}): PageRecordSummary => ({
  id,
  kind: 'concept',
  title: id,
  summary: '',
  updatedAt: '2025-01-01T00:00:00.000Z',
  revision: 'rev-1',
  origin: 'student',
  status: 'met',
  ...over,
});
const gnode = (pageId: string, courseId: string, subjectId: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id: `c:${pageId}`,
  kind: 'concept',
  label: pageId,
  origin: 'course',
  courseId,
  courseName: courseId,
  subjectId,
  semesterNumber: 1,
  pageId,
  status: 'met',
  misconceptions: 0,
  peer: false,
  ...over,
});
const graph: GraphResponse = {
  nodes: [gnode('force', 'mech', 'physics'), gnode('energy', 'mech', 'physics'), gnode('limit', 'calc', 'mathematics'), gnode('q-why', PERSONAL_SKY_ID, PERSONAL_SKY_ID, { kind: 'question' })],
  edges: [],
  stats: { courseConcepts: 3, lit: 3, shaky: 0, solid: 0, studentLinks: 0, personalPages: 1, collected: 0, demonstrated: 0 },
};
const records = [
  rec('force', { updatedAt: '2024-07-01T00:00:00.000Z', status: 'solid' }),
  rec('energy', { updatedAt: '2025-03-01T00:00:00.000Z', status: 'shaky' }),
  rec('limit'),
  rec('q-why', { kind: 'question', status: undefined, updatedAt: '2026-01-01T00:00:00.000Z' }),
];
const wiki: WikiGraph = {
  schemaVersion: 1 as never,
  nodes: [{ id: 'q-why', kind: 'question', title: 'Why?', summary: '', updatedAt: null, claims: 2, claimTexts: ['a', 'b'], sourceIds: ['src-1'], courseIds: [] }],
  edges: [
    { source: 'energy', target: 'limit', type: 'builds_upon', origin: 'student' },
    { source: 'force', target: 'missing', type: 'related_to', origin: 'student' },
  ],
};

test('pages become leaves on course branches; personal pages orbit the nucleus', () => {
  const map = buildBrainMap(records, graph, wiki);
  assert.equal(map.nodes.length, 4);
  assert.deepEqual(map.subjects.map((s) => s.name), ['Physics', 'Mathematics'], 'bigger subjects first, names prettified');
  assert.equal(map.branches.length, 2);
  for (const n of map.nodes) assert.ok(Math.hypot(n.x, n.y) <= 1.05, `${n.id} stays inside the disc`);
  const q = map.nodes.find((n) => n.id === 'q-why')!;
  assert.equal(q.branch, -1);
  assert.ok(Math.hypot(q.x, q.y) < 0.2, 'a personal page sits by the nucleus');
  assert.equal(map.nodes.find((n) => n.id === 'force')!.hex, '#ffe08a', 'solid is gold');
  assert.equal(map.links.length, 1, 'a link to a missing page is not drawn');
  assert.equal(map.seeds.length, 1, 'a kept source orbits the page it fed');
  assert.equal(map.stats.studentLinks, 1);
  assert.equal(map.stats.openQuestions, 1);
  assert.equal(map.nodes[map.timeline[0]!]!.id, 'force', 'the replay starts with the oldest page');
  assert.match(describeBrainMap(map), /4 pages across 2 courses in 2 subjects; 1 solid, 1 met, 1 shaky; 1 link you made; 1 open question/);
});

test('the layout is deterministic and survives a missing course graph', () => {
  assert.deepEqual(buildBrainMap(records, graph, wiki).nodes, buildBrainMap(records, graph, wiki).nodes);
  const bare = buildBrainMap(records, null, null);
  assert.equal(bare.branches.length, 0);
  assert.ok(bare.nodes.every((n) => n.branch === -1));
});
