import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MetricEvent } from '@sef/shared';
import { MetricsLog } from './log';

const event = (i: number, kind: MetricEvent['kind'] = 'suggestion_shown'): MetricEvent => ({ kind, ref: `r${i}`, at: new Date(Date.UTC(2026, 9, 17, 10, 0, i)).toISOString() });
const fresh = async () => path.join(await mkdtemp(path.join(tmpdir(), 'sef-metrics-')), 'eval-events.jsonl');

test('appends round-trip; a missing file reads as empty', async () => {
  const file = await fresh();
  const log = new MetricsLog(file);
  assert.deepEqual(await log.read(), []);
  await log.append([event(1), event(2, 'nudge_shown')]);
  await log.append([event(3)]);
  assert.deepEqual((await log.read()).map((e) => e.ref), ['r1', 'r2', 'r3']);
});

test('past the cap the file rotates to the newest events', async () => {
  const file = await fresh();
  const log = new MetricsLog(file, { max: 10, keep: 4 });
  for (let i = 0; i < 11; i++) await log.append([event(i)]);
  assert.deepEqual((await log.read()).map((e) => e.ref), ['r7', 'r8', 'r9', 'r10']);
  await log.append([event(11)]);
  assert.equal((await log.read()).length, 5, 'counting continues from the rotated size');
});

test('concurrent appends are serialised — no lost or interleaved lines', async () => {
  const file = await fresh();
  const log = new MetricsLog(file);
  await Promise.all(Array.from({ length: 40 }, (_, i) => log.append([event(i)])));
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 40);
  assert.equal(new Set((await log.read()).map((e) => e.ref)).size, 40);
});

test('corrupt or off-contract lines are skipped, and invalid events are never written', async () => {
  const file = await fresh();
  const log = new MetricsLog(file);
  await log.append([event(1)]);
  await appendFile(file, '{not json\n{"kind":"made_up","ref":"x","at":"2026-10-17T10:00:00.000Z"}\n');
  await log.append([{ kind: 'nudge_shown', ref: '', at: 'yesterday' } as unknown as MetricEvent, event(2)]);
  assert.deepEqual((await log.read()).map((e) => e.ref), ['r1', 'r2']);
});
