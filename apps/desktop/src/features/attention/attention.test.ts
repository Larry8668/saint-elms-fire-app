import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIGNAL_KINDS, type AttentionItem } from '@sef/shared';
import { bannerItems, destination, dueLabel, KIND_LABEL, newCountByTeacher, unseenKeys } from './attention';

const item = (key: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  key,
  kind: 'notice',
  title: key,
  detail: '',
  why: 'test',
  urgency: 'info',
  entityRefs: [],
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:00:00Z',
  state: 'new',
  highlight: true,
  ...extra,
});

test('every signal kind has a label and a deliberate destination', () => {
  for (const kind of SIGNAL_KINDS) {
    assert.ok(KIND_LABEL[kind], kind);
    assert.doesNotThrow(() => destination(item(`${kind}:x`, { kind })));
  }
  assert.deepEqual(destination(item('vault_question:p1:r', { kind: 'vault_question', entityRefs: ['page:p1'] })), { view: 'brain', params: { page: 'p1' } });
  assert.deepEqual(destination(item('deadline:l1:48h', { kind: 'deadline' })), { view: 'logistics' });
  assert.equal(destination(item('connectivity:uni:offline', { kind: 'connectivity' })), null, 'nothing to open while offline');
});

test('due labels are relative and never negative', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  assert.equal(dueLabel(undefined, now), null);
  assert.equal(dueLabel('2026-10-17T09:00:00Z', now), 'overdue');
  assert.equal(dueLabel('2026-10-17T10:20:00Z', now), 'within the hour');
  assert.equal(dueLabel('2026-10-18T22:00:00Z', now), 'in 36 h');
  assert.equal(dueLabel('2026-10-22T10:00:00Z', now), 'in 5 days');
});

test('the banner carries only urgent, unseen, policy-highlighted items', () => {
  const items = [
    item('a', { urgency: 'urgent' }),
    item('b', { urgency: 'urgent', highlight: false }),
    item('c', { urgency: 'urgent', state: 'seen' }),
    item('d', { urgency: 'soon' }),
  ];
  assert.deepEqual(bannerItems(items).map((i) => i.key), ['a']);
});

test('per-teacher badges count only new items in that teacher’s context', () => {
  const counts = newCountByTeacher([
    item('deadline:1', { kind: 'deadline' }),
    item('notice:2', { kind: 'notice', state: 'seen' }),
    item('release:3', { kind: 'release_update' }),
    item('q:4', { kind: 'vault_question' }),
    item('model:5', { kind: 'model_unavailable' }),
  ]);
  assert.deepEqual(counts, { friend: 1, guide: 1, philosopher: 1 });
  assert.deepEqual(unseenKeys([item('x'), item('y', { state: 'seen' })]), ['x']);
});
