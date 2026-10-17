import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultProactivity, type ProactivitySettings } from '@sef/shared';
import { attentionView, inQuietHours } from './policy';
import type { StoredSignal } from './store';

/** Local wall-clock dates, so quiet-hours checks do not depend on the host zone. */
const local = (h: number, m = 0) => new Date(2026, 9, 17, h, m);

const item = (key: string, extra: Partial<StoredSignal> = {}): StoredSignal => ({
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
  ...extra,
});

const settings = (patch: Partial<ProactivitySettings> = {}): ProactivitySettings => ({ ...defaultProactivity(), ...patch });
const quietNight = { enabled: true, start: '22:00', end: '07:00' };

test('quiet hours wrap past midnight and an equal start/end means never', () => {
  assert.equal(inQuietHours(quietNight, local(23)), true);
  assert.equal(inQuietHours(quietNight, local(3)), true);
  assert.equal(inQuietHours(quietNight, local(7)), false);
  assert.equal(inQuietHours(quietNight, local(12)), false);
  assert.equal(inQuietHours({ enabled: true, start: '13:00', end: '14:00' }, local(13, 30)), true);
  assert.equal(inQuietHours({ enabled: true, start: '09:00', end: '09:00' }, local(9)), false);
  assert.equal(inQuietHours({ ...quietNight, enabled: false }, local(23)), false);
});

test('quiet hours suppress highlighting but keep the item; a <24 h deadline breaks through', () => {
  const now = local(23);
  const soon = item('deadline:a:48h', { kind: 'deadline', urgency: 'urgent', dueAt: new Date(now.getTime() + 20 * 3_600_000).toISOString() });
  const later = item('deadline:b:48h', { kind: 'deadline', urgency: 'urgent', dueAt: new Date(now.getTime() + 40 * 3_600_000).toISOString() });
  const view = attentionView([item('notice:x'), later, soon], settings({ quietHours: quietNight }), now);
  assert.equal(view.quiet, true);
  assert.deepEqual(
    view.items.map((i) => [i.key, i.highlight]),
    [
      ['deadline:a:48h', true],
      ['deadline:b:48h', false],
      ['notice:x', false],
    ],
  );
});

test('dismissed, snoozed, disabled kinds and the master switch all hide items', () => {
  const now = local(12);
  const items = [
    item('notice:shown'),
    item('notice:dismissed', { state: 'dismissed' }),
    item('notice:snoozed', { snoozedUntil: new Date(now.getTime() + 3_600_000).toISOString() }),
    item('notice:woke', { snoozedUntil: new Date(now.getTime() - 1).toISOString() }),
    item('connectivity:uni:offline', { kind: 'connectivity' }),
  ];
  const kinds = { ...defaultProactivity().kinds, connectivity: false };
  assert.deepEqual(attentionView(items, settings({ kinds }), now).items.map((i) => i.key), ['notice:shown', 'notice:woke']);
  assert.deepEqual(attentionView(items, settings({ nudges: false }), now).items, []);
});
