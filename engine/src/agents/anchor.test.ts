import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExplorationAnchor } from '@sef/shared';
import { assertWellFormedAnchor, committedPageAnchors, requiresAnchor, unresolvableAnchors } from './anchor';

const committed = new Map([['page-damping', { pageId: 'page-damping', revision: 'r7', courseConceptKey: 'damping', courseRefs: ['mechanics'] }]]);

const resolve = (resolver: typeof committedPageAnchors, request: Parameters<typeof committedPageAnchors.resolve>[0]) => resolver.resolve(request);

test('only the Philosopher needs an anchor', () => {
  assert.equal(requiresAnchor('philosopher'), true);
  assert.equal(requiresAnchor('guide'), false);
  assert.equal(requiresAnchor('friend'), false);
});

test('the seam resolves nothing today, so the Philosopher fails closed', async () => {
  const none = await resolve(unresolvableAnchors, { teacher: 'philosopher', committed });
  assert.deepEqual(none, { ok: false, reason: 'no_anchor' });
  const syllabus = await resolve(unresolvableAnchors, { teacher: 'philosopher', syllabusConceptKey: 'damped-oscillations', committed });
  assert.deepEqual(syllabus, { ok: false, reason: 'syllabus_concept_not_an_anchor' });
});

test('a released syllabus concept is never an anchor', async () => {
  const result = await resolve(committedPageAnchors, { teacher: 'philosopher', syllabusConceptKey: 'damped-oscillations', committed });
  assert.deepEqual(result, { ok: false, reason: 'syllabus_concept_not_an_anchor' });
});

test('only a committed, course-linked page of this student’s wiki resolves', async () => {
  const none = await resolve(committedPageAnchors, { teacher: 'philosopher', committed });
  assert.deepEqual(none, { ok: false, reason: 'no_anchor' });

  const foreign = await resolve(committedPageAnchors, { teacher: 'philosopher', anchorPageId: 'page-someone-elses', committed });
  assert.deepEqual(foreign, { ok: false, reason: 'uncommitted_page' });

  const ok = await resolve(committedPageAnchors, { teacher: 'philosopher', anchorPageId: 'page-damping', committed });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.anchor.pageRevision, 'r7');
  assert.equal(ok.ok && ok.anchor.courseConceptKey, 'damping');
});

test('an anchor chosen against a page that has since changed is refused', async () => {
  const stale = await resolve(committedPageAnchors, { teacher: 'philosopher', anchorPageId: 'page-damping', claimedRevision: 'r3', committed });
  assert.deepEqual(stale, { ok: false, reason: 'stale_revision' });
});

test('a page with no course concept has nothing to explore outward from', async () => {
  const orphan = new Map([['page-orphan', { pageId: 'page-orphan', revision: 'r1', courseConceptKey: '', courseRefs: [] }]]);
  assert.deepEqual(await resolve(committedPageAnchors, { teacher: 'philosopher', anchorPageId: 'page-orphan', committed: orphan }), { ok: false, reason: 'not_a_course_concept' });
});

test('an anchor replayed over the wire is checked against the committed page', () => {
  const anchor: ExplorationAnchor = { pageId: 'page-damping', pageRevision: 'r7', courseConceptKey: 'damping', courseRefs: ['mechanics'] };
  assert.equal(assertWellFormedAnchor(anchor, committed.get('page-damping')), null);
  assert.equal(assertWellFormedAnchor(anchor, undefined), 'uncommitted_page');
  assert.equal(assertWellFormedAnchor({ ...anchor, pageRevision: 'r1' }, committed.get('page-damping')), 'stale_revision');
  assert.equal(assertWellFormedAnchor({ ...anchor, courseConceptKey: 'resonance' }, committed.get('page-damping')), 'not_a_course_concept');
});