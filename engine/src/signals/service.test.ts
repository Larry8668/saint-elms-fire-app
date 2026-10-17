import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultProactivity, type LogisticsRecord, type PeerFeedResponse, type ProactivitySettings, type SyncStatus } from '@sef/shared';
import type { Detector, SignalInputs } from './detectors';
import { MAX_SIGNALS, SignalService, STALE_AFTER_MS } from './service';
import { SignalStore } from './store';

const HOUR = 3_600_000;
const dir = await mkdtemp(path.join(tmpdir(), 'sef-signals-'));
let fileCount = 0;
const ledgerFile = () => path.join(dir, `signals-${(fileCount += 1)}.json`);

const deadline = (id: string, dueAt: Date): LogisticsRecord => ({
  id,
  title: `Deadline ${id}`,
  kind: 'deadline',
  state: 'confirmed',
  dueAt: dueAt.toISOString(),
  allDay: false,
  timeZone: 'UTC',
  details: '',
  provenance: { kind: 'manual' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

/** A clock and a mutable world the service reads through, standing in for the workspace stores. */
function harness(file = ledgerFile(), extra: { detectors?: Detector[]; proactivity?: ProactivitySettings } = {}) {
  const clock = { now: new Date('2026-10-17T10:00:00Z') };
  const world: Omit<SignalInputs, 'now' | 'observations'> = { logistics: [], jobs: [], questions: [], findings: [], health: { uni: true, models: [] } };
  let reads = 0;
  const service = new SignalService({
    store: new SignalStore(file),
    inputs: async () => {
      reads += 1;
      return { ...world };
    },
    proactivity: async () => extra.proactivity ?? defaultProactivity(),
    now: () => clock.now,
    detectors: extra.detectors,
  });
  return { service, world, clock, file, reads: () => reads };
}

test('a deadline due in 36 h appears as an urgent item without any student action, then clears once resolved', async () => {
  const h = harness();
  h.world.logistics = [deadline('fees', new Date(h.clock.now.getTime() + 36 * HOUR))];
  const first = await h.service.list();
  assert.deepEqual(first.items.map((i) => [i.key, i.urgency, i.state, i.highlight]), [['deadline:fees:48h', 'urgent', 'new', true]]);

  h.world.logistics = [];
  await h.service.evaluate();
  assert.deepEqual((await h.service.view()).items, []);
});

test('repeat evaluations are idempotent by key and keep createdAt', async () => {
  const h = harness();
  h.world.logistics = [deadline('fees', new Date(h.clock.now.getTime() + 36 * HOUR))];
  await h.service.evaluate();
  const before = (await h.service.view()).items[0]!;
  h.clock.now = new Date(h.clock.now.getTime() + 60_000);
  await h.service.evaluate();
  await h.service.evaluate();
  const after = (await h.service.view()).items;
  assert.equal(after.length, 1);
  assert.equal(after[0]!.createdAt, before.createdAt);
  assert.equal(after[0]!.updatedAt, before.updatedAt, 'unchanged content keeps its timestamp');
});

test('new → seen → dismissed; escalation re-news a seen item but never a dismissed one', async () => {
  let urgency: 'info' | 'soon' = 'info';
  const two: Detector = {
    kind: 'notice',
    detect: () => ['a', 'b'].map((id) => ({ key: `notice:${id}`, kind: 'notice' as const, title: id, detail: '', why: 'test', urgency, entityRefs: [] })),
  };
  const h = harness(ledgerFile(), { detectors: [two] });
  await h.service.evaluate();
  assert.equal(await h.service.markSeen(['notice:a', 'notice:b', 'missing']), 2);
  assert.equal(await h.service.dismiss('notice:b'), 'ok');
  assert.equal(await h.service.dismiss('nope'), 'not_found');
  assert.deepEqual((await h.service.view()).items.map((i) => [i.key, i.state]), [['notice:a', 'seen']]);

  urgency = 'soon';
  await h.service.evaluate();
  assert.deepEqual((await h.service.view()).items.map((i) => [i.key, i.state]), [['notice:a', 'new']]);
});

test('a deadline closing in moves to a new 48 h key, so it surfaces again even after the 7 d item was dismissed', async () => {
  const h = harness();
  const due = new Date(h.clock.now.getTime() + 5 * 24 * HOUR);
  h.world.logistics = [deadline('fees', due)];
  await h.service.evaluate();
  await h.service.dismiss('deadline:fees:7d');
  h.clock.now = new Date(due.getTime() - 30 * HOUR);
  await h.service.evaluate();
  assert.deepEqual((await h.service.view()).items.map((i) => [i.key, i.state]), [['deadline:fees:48h', 'new']]);
});

test('a dismissal survives an engine restart (a new service over the same file)', async () => {
  const h = harness();
  h.world.logistics = [deadline('fees', new Date(h.clock.now.getTime() + 36 * HOUR))];
  await h.service.evaluate();
  await h.service.dismiss('deadline:fees:48h');

  const restarted = harness(h.file);
  restarted.world.logistics = h.world.logistics;
  await restarted.service.evaluate();
  assert.deepEqual((await restarted.service.view()).items, []);
  const ledger = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(ledger.items['deadline:fees:48h'].state, 'dismissed');
});

test('snooze hides an item until it expires, then it returns', async () => {
  const h = harness();
  h.world.logistics = [deadline('fees', new Date(h.clock.now.getTime() + 5 * 24 * HOUR))];
  await h.service.evaluate();
  assert.equal(await h.service.snooze('deadline:fees:7d', 2), 'ok');
  assert.deepEqual((await h.service.view()).items, []);
  h.clock.now = new Date(h.clock.now.getTime() + 3 * HOUR);
  assert.equal((await h.service.view()).items.length, 1);
});

test('an unreadable source preserves its existing items instead of clearing them', async () => {
  const h = harness();
  h.world.logistics = [deadline('fees', new Date(h.clock.now.getTime() + 36 * HOUR))];
  await h.service.evaluate();
  h.world.logistics = undefined;
  await h.service.evaluate();
  assert.equal((await h.service.view()).items.length, 1);
});

test('a throwing detector is contained and its kind preserved', async () => {
  let fail = false;
  const flaky: Detector = {
    kind: 'notice',
    detect: () => {
      if (fail) throw new Error('boom');
      return [{ key: 'notice:x', kind: 'notice', title: 'x', detail: '', why: 'test', urgency: 'info', entityRefs: [] }];
    },
  };
  const h = harness(ledgerFile(), { detectors: [flaky] });
  await h.service.evaluate();
  fail = true;
  await h.service.evaluate();
  assert.deepEqual((await h.service.view()).items.map((i) => i.key), ['notice:x']);
});

test('list() evaluates only when the ledger is stale', async () => {
  const h = harness();
  await h.service.list();
  await h.service.list();
  assert.equal(h.reads(), 1);
  h.clock.now = new Date(h.clock.now.getTime() + STALE_AFTER_MS + 1);
  await h.service.list();
  assert.equal(h.reads(), 2);
});

test('quiet hours suppress highlighting but the ledger still records the item', async () => {
  const quiet = { ...defaultProactivity(), quietHours: { enabled: true, start: '00:00', end: '23:59' } };
  const h = harness(ledgerFile(), { proactivity: quiet });
  h.world.logistics = [deadline('far', new Date(h.clock.now.getTime() + 5 * 24 * HOUR))];
  const view = await h.service.list();
  assert.equal(view.quiet, true);
  assert.equal(view.items[0]!.highlight, false);
  assert.ok(JSON.parse(await readFile(h.file, 'utf8')).items['deadline:far:7d']);
});

test('the ledger is capped, keeping the most urgent items', async () => {
  const many: Detector = {
    kind: 'notice',
    detect: () =>
      Array.from({ length: MAX_SIGNALS + 25 }, (_, i) => ({
        key: `notice:${i}`,
        kind: 'notice' as const,
        title: `n${i}`,
        detail: '',
        why: 'test',
        urgency: i === MAX_SIGNALS + 24 ? ('urgent' as const) : ('info' as const),
        entityRefs: [],
      })),
  };
  const h = harness(ledgerFile(), { detectors: [many] });
  await h.service.evaluate();
  const ledger = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(Object.keys(ledger.items).length, MAX_SIGNALS);
  assert.ok(ledger.items[`notice:${MAX_SIGNALS + 24}`], 'the urgent item survives the cap');
});

test('each profile has its own ledger: A’s signals never surface for B', async () => {
  const a = harness();
  const b = harness();
  a.world.logistics = [deadline('a-only', new Date(a.clock.now.getTime() + 36 * HOUR))];
  await a.service.evaluate();
  await b.service.evaluate();
  assert.equal((await a.service.view()).items.length, 1);
  assert.deepEqual((await b.service.view()).items, []);
});

test('sync and feed observations raise release and share items; failed reads keep the last snapshot', async () => {
  const h = harness();
  const status = {
    uniReachable: true,
    cohortId: 'c-1',
    courses: [
      { id: 'phy-101', title: 'Mechanics', semesterNumber: 1, subjectId: 's', lessonCount: 3, remoteVersion: '1.2.0', localVersion: '1.1.0', state: 'update', support: false },
      { id: 'phy-102', title: 'Waves', semesterNumber: 1, subjectId: 's', lessonCount: 3, remoteVersion: '1.0.0', localVersion: '1.0.0', state: 'installed', support: false },
    ],
  } as SyncStatus;
  const feed = {
    state: 'ok',
    items: [
      { id: 'sh-1', revision: 'r1', senderName: 'Brinda', mine: false, import: null, ignored: false, payload: { title: 'Notes' } },
      { id: 'sh-2', revision: 'r1', senderName: 'Me', mine: true, import: null, ignored: false, payload: { title: 'Mine' } },
      { id: 'sh-3', revision: 'r1', senderName: 'Chetna', mine: false, import: { sourceId: 's', jobId: 'j' }, ignored: false, payload: { title: 'Done' } },
    ],
  } as unknown as PeerFeedResponse;
  await h.service.observeSync(status);
  await h.service.observeFeed(feed);
  await h.service.observeSync({ ...status, uniReachable: false, courses: [] });
  await h.service.observeFeed({ ...feed, state: 'unavailable', items: [] } as PeerFeedResponse);
  await h.service.evaluate();
  assert.deepEqual((await h.service.view()).items.map((i) => i.key).sort(), ['release_update:phy-101:1.2.0', 'share_incoming:sh-1:r1']);
});

test('a corrupt ledger is rebuilt rather than crashing', async () => {
  const file = ledgerFile();
  await writeFile(file, '{ not json');
  const h = harness(file);
  h.world.logistics = [deadline('fees', new Date(h.clock.now.getTime() + 36 * HOUR))];
  assert.equal((await h.service.list()).items.length, 1);
});
