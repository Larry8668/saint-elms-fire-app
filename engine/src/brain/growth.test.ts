import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, SourceRecordSchema, type SourceRecord, type WikiPageDraft } from '@sef/shared';
import { sha256Hex } from '../lib/hash';
import { conceptDraft, proposal, sourceFixture, synthesisDraft, vault } from './testing/fixtures';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-growth-'));

function peerSource(id: string, text: string): { record: SourceRecord; bytes: Buffer } {
  const bytes = Buffer.from(text, 'utf8');
  const record = SourceRecordSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id,
    profile: { issuer: 'https://uni.example.test', studentId: 'student-a', programmeId: 'bsc-physics' },
    revision: 'rev-1',
    title: `Share ${id}`,
    createdAt: '2026-10-15T10:00:00.000Z',
    mediaType: 'text/markdown',
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    attribution: {},
    extractions: [],
    kind: 'peer',
    origin: 'peer',
    share: { id: 'share-1', revision: 'rev-9', senderId: 'peer-b', cohortId: 'cohort-a' },
  });
  return { record, bytes };
}

const questionDraft = (id: string, sourceIds: string[]): WikiPageDraft =>
  ({
    kind: 'question',
    id,
    title: `Question ${id}`,
    summary: `What ${id} asks.`,
    markdown: '## The question\n\nStill open.',
    courseRefs: [],
    claims: [],
    links: [],
    sourceIds,
  }) as WikiPageDraft;

test('a created concept page records one attributable encounter, marked as the student\u2019s when her own source backs it', async () => {
  const store = await vault('growth-encounter');
  const { record, bytes } = sourceFixture('source-note', 'student note about momentum');
  await store.putSource(record, bytes);

  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('momentum') }], { momentum: null }, { sourceIds: ['source-note'] }));

  const events = await store.listEvents('momentum');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'encounter');
  assert.equal(events[0]?.actor, 'student');
  assert.equal(events[0]?.knowledgeOnly, false);
  assert.equal(events[0]?.profile.studentId, 'student-a');
  assert.ok(events[0]!.evidence.length >= 1, 'an event always cites something');
});

test('a synthesis page records an application event, and a question page an encounter that opens it', async () => {
  const store = await vault('growth-kinds');
  const { record, bytes } = sourceFixture('source-note', 'reading note');
  await store.putSource(record, bytes);

  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: synthesisDraft('work-synthesis', ['source-note']) },
        { op: 'upsert_page', page: questionDraft('drag-question', ['source-note']) },
      ],
      { 'work-synthesis': null, 'drag-question': null },
      { sourceIds: ['source-note'] },
    ),
  );

  const synthesis = await store.listEvents('work-synthesis');
  assert.deepEqual(synthesis.map((e) => e.kind), ['application']);
  const question = await store.listEvents('drag-question');
  assert.deepEqual(question.map((e) => e.kind), ['encounter']);
  assert.match(question[0]?.note ?? '', /question/i);
});

test('a page built only from a peer share is collected material — peer actor, knowledge-only, never the student\u2019s mastery', async () => {
  const store = await vault('growth-peer');
  const { record, bytes } = peerSource('peer-share', 'Arjun\u2019s Green\u2019s functions one-pager');
  await store.putSource(record, bytes);

  await store.applyProposal(
    proposal(
      [
        {
          op: 'upsert_page',
          page: conceptDraft('green-s-functions', {
            learner: { inMyWords: '', stuck: '', connections: '', evidenceIds: [] },
            claims: [
              {
                id: 'cl-1',
                text: 'The response to a sum of impulses is the sum of impulse responses.',
                kind: 'source_fact',
                origin: 'peer',
                status: 'current',
                citations: [{ sourceId: 'peer-share', sourceRevision: 'rev-1', sha256: sha256Hex(bytes), locator: { kind: 'text', start: 0, end: 10 } }],
                supersedes: [],
              },
            ],
            courseRefs: [],
          }),
        },
      ],
      { 'green-s-functions': null },
      { sourceIds: ['peer-share'] },
    ),
  );

  const events = await store.listEvents('green-s-functions');
  assert.ok(events.length >= 1);
  for (const event of events) {
    assert.equal(event.knowledgeOnly, true, `${event.kind} from a peer share is collected, never demonstrated`);
    assert.notEqual(event.actor, 'student');
  }
});

test('updating a page\u2019s own-words section records an explanation at a new revision', async () => {
  const store = await vault('growth-revision');
  const { record, bytes } = sourceFixture('source-note', 'note');
  await store.putSource(record, bytes);
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('momentum') }], { momentum: null }, { sourceIds: ['source-note'] }));

  const committed = await store.readPage('momentum');
  await store.applyProposal(
    proposal(
      [
        {
          op: 'upsert_page',
          page: conceptDraft('momentum', {
            learner: { inMyWords: 'Momentum is conserved because forces cancel in pairs.', stuck: 'Satellites.', connections: 'Impulse.', evidenceIds: [] },
          }),
        },
      ],
      { momentum: committed?.revision ?? '' },
      { id: 'proposal-2', sourceIds: ['source-note'] },
    ),
  );

  const events = await store.listEvents('momentum');
  assert.deepEqual(events.map((e) => e.kind).sort(), ['encounter', 'explanation'], 'each revision adds its own event');
});

test('an unchanged replay writes no new event — the ledger is keyed by revision, not by submission', async () => {
  const store = await vault('growth-replay');
  const { record, bytes } = sourceFixture('source-note', 'note');
  await store.putSource(record, bytes);
  const draft = conceptDraft('momentum');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: draft }], { momentum: null }, { sourceIds: ['source-note'] }));
  const committed = await store.readPage('momentum');
  const before = await store.listEvents('momentum');

  // Same content again — a retried accept. Nothing new is committed, and the ledger stays put.
  const replay = await store.applyProposal(proposal([{ op: 'upsert_page', page: draft }], { momentum: committed?.revision ?? '' }, { id: 'proposal-replay', sourceIds: ['source-note'] }));
  assert.equal(replay.committed, false);
  assert.deepEqual(await store.listEvents('momentum'), before, 'a retry cannot duplicate growth events');
});

test('new links record connection events with the link\u2019s own provenance', async () => {
  const store = await vault('growth-links');
  const { record, bytes } = sourceFixture('source-note', 'the student wrote that impulse connects these');
  await store.putSource(record, bytes);
  await store.applyProposal(
    proposal(
      [{ op: 'upsert_page', page: conceptDraft('impulse') }, { op: 'upsert_page', page: conceptDraft('momentum-change') }],
      { impulse: null, 'momentum-change': null },
      { sourceIds: ['source-note'] },
    ),
  );
  const impulse = await store.readPage('impulse');
  const citation = { sourceId: 'source-note', sourceRevision: 'rev-1', sha256: sha256Hex(bytes), locator: { kind: 'text' as const, start: 0, end: 12 } };
  await store.applyProposal(
    proposal(
      [{ op: 'add_link', fromPageId: 'impulse', link: { toPageId: 'momentum-change', type: 'related_to', origin: 'student', why: 'The student linked them.', citations: [citation] } }],
      { impulse: impulse?.revision ?? '' },
      { id: 'proposal-link', sourceIds: ['source-note'] },
    ),
  );

  const events = await store.listEvents('impulse');
  const connection = events.find((e) => e.kind === 'connection');
  assert.ok(connection, 'the new link left a connection event');
  assert.equal(connection.actor, 'student');
  assert.equal(connection.knowledgeOnly, false);
});

test('events for one page only ever show that page\u2019s trail', async () => {
  const store = await vault('growth-scope');
  const { record, bytes } = sourceFixture('source-note', 'note');
  await store.putSource(record, bytes);
  await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('alpha') }, { op: 'upsert_page', page: conceptDraft('beta') }], { alpha: null, beta: null }, { sourceIds: ['source-note'] }),
  );

  const all = await store.listEvents();
  assert.ok(all.every((e) => ['alpha', 'beta'].includes(e.pageId)));
  assert.deepEqual((await store.listEvents('alpha')).map((e) => e.pageId), ['alpha']);
});
