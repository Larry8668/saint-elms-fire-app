import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LogisticsWrite } from '@sef/shared';
import { LogisticsNotFound, LogisticsStateError, LogisticsStore } from './store';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-logistics-'));
const file = path.join(dir, 'logistics.json');

const write = (over: Partial<LogisticsWrite> = {}): LogisticsWrite => ({
  title: 'Semester fees — instalment 2',
  kind: 'deadline',
  dueAt: '2026-03-14T11:30:00.000Z',
  allDay: false,
  timeZone: 'Asia/Kolkata',
  details: '',
  ...over,
});

test('a student-typed record is confirmed at birth and survives a reload', async () => {
  const store = new LogisticsStore(file);
  const created = await store.create(write(), { kind: 'manual' });
  assert.equal(created.state, 'confirmed');
  assert.equal(created.provenance.kind, 'manual');
  assert.match(created.id, /^log-/);

  const reopened = new LogisticsStore(file);
  assert.deepEqual((await reopened.get(created.id))?.title, created.title);
  assert.equal((await reopened.confirmed()).length, 1);
});

test('extraction proposals land unconfirmed and dedupe against what is already held', async () => {
  const store = new LogisticsStore(file);
  const drafts = [write({ title: 'Physics lab exam', kind: 'timetable' }), write({ title: 'Physics lab exam', kind: 'timetable' })];
  const filed = await store.propose(drafts, { kind: 'friend_extraction', extractedFrom: 'image' });
  assert.equal(filed.length, 1, 'identical drafts inside one batch collapse');
  assert.equal(filed[0]!.state, 'proposed');
  const again = await store.propose(drafts, { kind: 'friend_extraction', extractedFrom: 'image' });
  assert.equal(again.length, 0, 'a draft matching a held record is skipped, not filed twice');
});

test('only the student’s confirmation turns a proposal into fact', async () => {
  const store = new LogisticsStore(file);
  const [proposal] = await store.propose([write({ title: 'Hostel meeting' })], { kind: 'friend_extraction' });
  assert.equal((await store.confirmed()).some((r) => r.id === proposal!.id), false);

  const confirmed = await store.confirm(proposal!.id, { details: 'Checked against the notice board.' });
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.details, 'Checked against the notice board.');
  assert.equal((await store.confirmed()).some((r) => r.id === proposal!.id), true);

  await assert.rejects(() => store.confirm(proposal!.id), LogisticsStateError, 'already confirmed — confirming again is not a transition');
});

test('a dismissed proposal is kept for audit but can no longer be edited or confirmed', async () => {
  const store = new LogisticsStore(file);
  const [proposal] = await store.propose([write({ title: 'Canteen notice' })], { kind: 'friend_extraction' });
  const dismissed = await store.dismiss(proposal!.id);
  assert.equal(dismissed.state, 'dismissed');
  assert.equal((await store.proposed()).some((r) => r.id === proposal!.id), false, 'a dismissed record no longer counts as proposed');
  await assert.rejects(() => store.confirm(proposal!.id), LogisticsStateError);
  await assert.rejects(() => store.update(proposal!.id, { title: 'retitled' }), LogisticsStateError);
  assert.equal((await store.get(proposal!.id))?.state, 'dismissed', 'dismissal is recorded, not deleted');
});

test('update and remove act on real records only', async () => {
  const store = new LogisticsStore(file);
  const created = await store.create(write(), { kind: 'manual' });
  const updated = await store.update(created.id, { title: 'Fees — final reminder', dueAt: '2026-03-20', allDay: true, timeZone: null });
  assert.equal(updated.title, 'Fees — final reminder');
  assert.equal(updated.dueAt, '2026-03-20');
  assert.equal(updated.state, 'confirmed', 'editing does not demote a confirmed record');

  await assert.rejects(() => store.update('log-missing', { title: 'x' }), LogisticsNotFound);
  await assert.rejects(() => store.confirm('log-missing'), LogisticsNotFound);
  await assert.rejects(() => store.dismiss('log-missing'), LogisticsNotFound);
  assert.equal(await store.remove('log-missing'), false);
  assert.equal(await store.remove(created.id), true);
  assert.equal(await store.get(created.id), null);
});

test('concurrent mutations serialise — no lost update between an edit and a proposal', async () => {
  const store = new LogisticsStore(path.join(dir, 'concurrent.json'));
  const [created] = await Promise.all([
    store.create(write({ title: 'A' }), { kind: 'manual' }),
    store.propose([write({ title: 'B' })], { kind: 'friend_extraction' }),
    store.create(write({ title: 'C' }), { kind: 'manual' }),
  ]);
  assert.ok(created.id);
  const titles = (await store.list()).map((r) => r.title).sort();
  assert.deepEqual(titles, ['A', 'B', 'C'], 'every write landed — the queue held the ordering');
});

test.after(async () => rm(dir, { recursive: true, force: true }));
