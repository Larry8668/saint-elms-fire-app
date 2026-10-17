import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, StudyPlanSchema, type PlanStep, type StudyPlan } from '@sef/shared';
import { proposeRevision, pruneAtApproval, recompute } from './progress';
import { makeWorld, NOW } from './testing/world';

const APPROVED = '2026-10-14T00:00:00.000Z';
const BEFORE = '2026-10-13T00:00:00.000Z';
const AFTER = '2026-10-14T12:00:00.000Z';

const s = (id: string, kind: PlanStep['kind'], ref: string, subject = 'Subject'): PlanStep => ({ id, title: `Step ${id}`, detail: '', kind, entityRefs: [ref], subject, state: 'pending' });

const plan = (steps: PlanStep[], extra: Partial<StudyPlan> = {}): StudyPlan => ({
  schemaVersion: CONTRACT_VERSION,
  id: 'plan_aaaaaaaaaaaa',
  goal: 'Revise thermodynamics before Thursday',
  createdAt: BEFORE,
  updatedAt: APPROVED,
  deadlineAt: null,
  status: 'active',
  approvedAt: APPROVED,
  steps,
  notes: [],
  basis: { phys201: '1.2.0' },
  ...extra,
});

test('a growth event on the page after approval marks a review step done — no bookkeeping', () => {
  const p = plan([s('st_1', 'review_page', 'page:entropy'), s('st_2', 'review_page', 'page:thermo-first-law')]);
  const next = recompute(p, makeWorld({ events: [{ pageId: 'entropy', at: AFTER }, { pageId: 'thermo-first-law', at: BEFORE }] }));
  assert.equal(next.steps[0]!.state, 'done');
  assert.equal(next.steps[0]!.doneAt, AFTER);
  assert.equal(next.steps[1]!.state, 'pending', 'evidence from before approval does not count');
  assert.equal(next.status, 'active');
  StudyPlanSchema.parse(next);
});

test('quiz, lesson, question and signal steps each read their own evidence', () => {
  const p = plan([
    s('st_1', 'quiz', 'page:entropy'),
    s('st_2', 'read_lesson', 'lesson:l-heat-engines'),
    s('st_3', 'answer_question', 'page:q-carnot'),
    s('st_4', 'resolve_signal', 'signal:deadline:log-1:48h'),
  ]);
  const world = makeWorld({
    quizzes: [{ pageId: 'entropy', at: AFTER }],
    lessonActivity: [{ lessonId: 'l-heat-engines', at: AFTER }],
    events: [{ pageId: 'q-carnot', at: AFTER }],
    signals: new Map(),
  });
  const next = recompute(p, world);
  assert.deepEqual(next.steps.map((x) => x.state), ['done', 'done', 'done', 'done']);
  assert.equal(next.status, 'completed');
  assert.equal(next.steps[3]!.doneAt, NOW.toISOString());
});

test('nothing changes without new evidence; proposed plans are never tracked', () => {
  const p = plan([s('st_1', 'review_page', 'page:entropy')]);
  assert.equal(recompute(p, makeWorld()), p);
  const proposed = plan([s('st_1', 'review_page', 'page:entropy')], { status: 'proposed', approvedAt: undefined });
  assert.equal(recompute(proposed, makeWorld({ events: [{ pageId: 'entropy', at: AFTER }] })), proposed);
});

test('deleting a referenced page marks its step stale; done steps never revert', () => {
  const p = plan([{ ...s('st_1', 'review_page', 'page:thermo-first-law'), state: 'done', doneAt: AFTER }, s('st_2', 'review_page', 'page:entropy'), s('st_3', 'quiz', 'page:thermo-first-law')]);
  const world = makeWorld();
  world.pages.delete('entropy');
  world.pages.delete('thermo-first-law');
  const next = recompute(p, world);
  assert.deepEqual(next.steps.map((x) => x.state), ['done', 'stale', 'stale']);
  assert.match(next.notes.join(' '), /stale/);
});

test('a new course release marks lesson steps stale', () => {
  const p = plan([s('st_1', 'read_lesson', 'lesson:l-enthalpy', 'Enthalpy'), s('st_2', 'review_page', 'page:entropy')]);
  const next = recompute(p, makeWorld({ courseVersions: { phys201: '1.3.0' } }));
  assert.equal(next.steps[0]!.state, 'stale');
  assert.match(next.notes[0]!, /new release/);
  assert.equal(next.steps[1]!.state, 'pending');
});

test('a revision drops stale steps, keeps done and pending, and waits for approval', () => {
  const p = plan([{ ...s('st_1', 'review_page', 'page:a'), state: 'done', doneAt: AFTER }, { ...s('st_2', 'review_page', 'page:b'), state: 'stale' }, s('st_3', 'quiz', 'page:entropy')]);
  const revision = proposeRevision(p, 'plan_bbbbbbbbbbbb', NOW)!;
  assert.equal(revision.status, 'proposed');
  assert.equal(revision.revisionOf, p.id);
  assert.equal(revision.approvedAt, undefined);
  assert.deepEqual(revision.steps.map((x) => [x.id, x.state]), [['st_1', 'done'], ['st_3', 'pending']], 'step ids survive a revision');
  StudyPlanSchema.parse(revision);
  assert.equal(proposeRevision(plan([{ ...s('st_1', 'review_page', 'page:a'), state: 'stale' }]), 'plan_cccccccccccc', NOW), null, 'nothing left to do → no revision');
});

test('approval drops steps whose signal already cleared or whose entity vanished — never credits them', () => {
  const p = plan([s('st_1', 'resolve_signal', 'signal:deadline:log-1:48h'), s('st_2', 'review_page', 'page:entropy'), s('st_3', 'review_page', 'page:gone')], { status: 'proposed', approvedAt: undefined });
  const pruned = pruneAtApproval(p, makeWorld({ signals: new Map() }));
  assert.deepEqual(pruned.steps.map((x) => x.id), ['st_2']);
  assert.equal(pruned.notes.length, 2);
  assert.ok(pruned.steps.every((x) => x.state === 'pending'));
});

test('a step with no usable ref is inert rather than a crash', () => {
  const broken = plan([{ ...s('st_1', 'review_page', 'page:entropy'), entityRefs: [] as unknown as [string] }]);
  assert.doesNotThrow(() => recompute(broken, makeWorld()));
});
