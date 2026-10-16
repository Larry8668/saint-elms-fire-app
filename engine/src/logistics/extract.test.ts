import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ChatAttachment, LogisticsDraft } from '@sef/shared';
import type { generateStructured } from '../agents/factory';
import type { ResolvedModel } from '../models/registry';
import { extractLogistics, sanitiseDraft } from './extract';
import { LogisticsStore } from './store';
import { logisticsContext } from './context';
import { TurnContext } from '../agents/context';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-logistics-extract-'));

const image: ChatAttachment = { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
const resolved = { label: 'gemma4:e4b · Ollama (on this device)' } as ResolvedModel;

/** A fake vision pass; `read` is the seam generateStructured normally fills. */
const reader =
  (records: unknown[]): typeof generateStructured =>
  async () =>
    ({ object: { records }, ms: 1 }) as never;

const failing = (async () => {
  throw new Error('model unreachable');
}) as unknown as typeof generateStructured;

const draft: LogisticsDraft = { title: 'Physics lab exam', kind: 'timetable', dueAt: '2026-03-14', allDay: false, timeZone: null, details: 'LH-2, bring ID' };

test('readable entries land as proposals carrying the model’s provenance', async () => {
  const store = new LogisticsStore(path.join(dir, 'a.json'));
  const outcome = await extractLogistics(image, resolved, store, { read: reader([draft, draft]) });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.proposed.length, 1, 'duplicate drafts dedupe');
    const record = outcome.proposed[0]!;
    assert.equal(record.state, 'proposed');
    assert.equal(record.provenance.kind, 'friend_extraction');
    assert.equal(record.provenance.extractedFrom, 'image');
    assert.match(record.provenance.model ?? '', /Ollama/);
    assert.equal(record.allDay, true, 'a bare date is a day, not a midnight');
  }
});

test('what the model claims to see is lane-checked before anything is filed', async () => {
  const store = new LogisticsStore(path.join(dir, 'b.json'));
  const dirty = { ...draft, title: 'Class list', details: 'my roommate’s phone number is 98450 11223' };
  const outcome = await extractLogistics(image, resolved, store, { read: reader([dirty]) });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, 'privacy');
  assert.equal((await store.list()).length, 0, 'a privacy verdict files nothing');
});

test('an unreachable model and an empty read are honest outcomes, not crashes', async () => {
  const store = new LogisticsStore(path.join(dir, 'c.json'));
  const unavailable = await extractLogistics(image, resolved, store, { read: failing });
  assert.deepEqual(unavailable.ok ? 'ok' : unavailable.reason, 'unavailable');
  const empty = await extractLogistics(image, resolved, store, { read: reader([]) });
  assert.deepEqual(empty.ok ? 'ok' : empty.reason, 'nothing_found');
  assert.equal((await store.list()).length, 0);
});

test('sanitise keeps the truth: bad dates become notes, invented zones are dropped', () => {
  const messy = sanitiseDraft({ ...draft, dueAt: 'next Friday', timeZone: 'Mars/Olympus' });
  assert.equal(messy.dueAt, null, 'an unreadable date is left empty, not guessed');
  assert.match(messy.details, /the image shows “next Friday”/, 'the raw text is kept for the student to check');
  assert.equal(messy.timeZone, null);
  assert.match(messy.details, /names “Mars\/Olympus” as the zone/);

  const clean = sanitiseDraft({ ...draft, dueAt: '2026-03-14T15:00', timeZone: 'Asia/Kolkata' });
  assert.deepEqual({ dueAt: clean.dueAt, allDay: clean.allDay, timeZone: clean.timeZone }, { dueAt: '2026-03-14T15:00', allDay: false, timeZone: 'Asia/Kolkata' });
});

test('the Friend’s context carries confirmed records as citable and proposals as withheld', async () => {
  const store = new LogisticsStore(path.join(dir, 'd.json'));
  await store.create({ title: 'Fees — instalment 2', kind: 'deadline', dueAt: '2026-03-14', allDay: true, timeZone: 'Asia/Kolkata', details: '' }, { kind: 'manual' });
  const [proposal] = await store.propose([{ title: 'Exam timetable draft', kind: 'timetable', dueAt: null, allDay: false, timeZone: null, details: '' }], { kind: 'friend_extraction' });

  const ctx = new TurnContext(() => {});
  await logisticsContext(store, ctx);
  const prompt = [...ctx.contextBlocks, ...ctx.shieldedBlocks].join('\n');
  assert.match(prompt, /YOUR LOGISTICS/);
  assert.match(prompt, /Fees — instalment 2.*due 2026-03-14 \(Asia\/Kolkata\)/, 'a confirmed record shows its zone');
  assert.match(prompt, /UNCONFIRMED LOGISTICS/);
  assert.match(prompt, /Exam timetable draft/);
  assert.ok(ctx.sources.get('logistics:' + (await store.confirmed())[0]!.id), 'confirmed records enter as citable sources');
  assert.equal(ctx.proposedLogistics[0]?.id, proposal!.id, 'proposals enter as withheld evidence');
});

test('an empty ledger still teaches the Friend to say “nothing recorded”', async () => {
  const ctx = new TurnContext(() => {});
  await logisticsContext(new LogisticsStore(path.join(dir, 'empty.json')), ctx);
  assert.match(ctx.contextBlocks.join('\n'), /nothing recorded yet/);
});

test.after(async () => rm(dir, { recursive: true, force: true }));
