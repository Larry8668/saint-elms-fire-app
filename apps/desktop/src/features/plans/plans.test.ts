import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, type PlanStep, type StudyPlan } from '@sef/shared';
import { countdown, deadlineFromDate, progressOf, refLabel, stepAction, visiblePlans } from './plans';

const step = (kind: PlanStep['kind'], ref: string, state: PlanStep['state'] = 'pending'): PlanStep => ({ id: 'st_1', title: 't', detail: '', kind, entityRefs: [ref], subject: 'Entropy', state });
const plan = (id: string, status: StudyPlan['status'], updatedAt = '2026-10-10T00:00:00.000Z', steps: PlanStep[] = [step('quiz', 'page:entropy')]): StudyPlan => ({
  schemaVersion: CONTRACT_VERSION,
  id,
  goal: 'g',
  createdAt: updatedAt,
  updatedAt,
  deadlineAt: null,
  status,
  steps,
  notes: [],
});

test('each step kind links to where the student does the work; nothing is executed', () => {
  assert.deepEqual(stepAction(step('review_page', 'page:entropy')), { label: 'Open in sky', view: 'sky', params: { page: 'entropy' } });
  assert.deepEqual(stepAction(step('read_lesson', 'lesson:l-1')), { label: 'Read lesson', view: 'library', params: { lessonId: 'l-1' } });
  const quiz = stepAction(step('quiz', 'page:entropy'));
  assert.ok('view' in quiz && quiz.view === 'teachers' && quiz.params.teacher === 'guide' && quiz.params.draft === 'Quiz me on Entropy.');
  const signal = stepAction(step('resolve_signal', 'signal:deadline:log-1:48h'));
  assert.ok(!('view' in signal) && /Attention/.test(signal.hint));
});

test('reference labels name what each ref is', () => {
  assert.deepEqual(['page:a', 'lesson:b', 'signal:c:d', 'weird:x'].map(refLabel), ['Page', 'Lesson', 'Signal', 'Item']);
});

test('countdown: none, upcoming, today, urgent, overdue', () => {
  const now = Date.parse('2026-10-15T10:00:00.000Z');
  assert.equal(countdown(null, now), null);
  assert.equal(countdown('garbage', now), null);
  assert.deepEqual(countdown('2026-10-20T10:00:00.000Z', now), { text: 'due in 5 days', urgent: false });
  assert.deepEqual(countdown('2026-10-16T12:00:00.000Z', now), { text: 'due in 1 day', urgent: true });
  assert.deepEqual(countdown('2026-10-15T20:00:00.000Z', now), { text: 'due today', urgent: true });
  assert.deepEqual(countdown('2026-10-13T10:00:00.000Z', now), { text: '2 days overdue', urgent: true });
});

test('progress counts done and stale steps', () => {
  assert.deepEqual(progressOf(plan('p', 'active', undefined, [step('quiz', 'page:a', 'done'), step('quiz', 'page:b', 'stale'), step('quiz', 'page:c')])), { done: 1, stale: 1, total: 3 });
});

test('visible plans: open ones plus only the latest completed; abandoned hidden', () => {
  const ids = visiblePlans([plan('a', 'active'), plan('b', 'proposed'), plan('c', 'completed', '2026-10-01T00:00:00.000Z'), plan('d', 'completed', '2026-10-12T00:00:00.000Z'), plan('e', 'abandoned')]).map((p) => p.id);
  assert.deepEqual(ids, ['a', 'b', 'd']);
});

test('a picked date means the end of that local day; junk is ignored', () => {
  const iso = deadlineFromDate('2026-10-16')!;
  const local = new Date(iso);
  assert.deepEqual([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()], [2026, 9, 16, 23, 59]);
  assert.equal(deadlineFromDate(''), undefined);
  assert.equal(deadlineFromDate('16/10/2026'), undefined);
});
