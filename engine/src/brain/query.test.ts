import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { EngineSettings, SourceCitation, WikiClaim } from '@sef/shared';
import { buildEvidenceSet } from '../agents/evidence';
import { TurnContext } from '../agents/context';
import { buildTools } from '../agents/tools';
import type { ContentStore } from '../content/store';
import type { SettingsReader } from '../settings/store';
import type { Session } from '../sessions/store';
import { conceptDraft, PROFILE, proposal, sourceFixture, synthesisDraft, T0, tempRoot, vault } from './testing/fixtures';
import { WikiQuery } from './query';
import { BrainService } from './service';
import { SourceIngestor, SourceRejection } from './sources/ingest';
import { BrainVault } from './vault';
import { VaultConflictError } from './vault-errors';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-wiki-query-'));

const settings: SettingsReader = {
  get: async () =>
    ({
      uniServerUrl: 'https://uni.example.test',
      searxngUrl: '',
      thinking: false,
      providers: [{ id: 'p', kind: 'ollama', label: 'Test model' }],
      roles: { tutor: { provider: 'p', model: 'm' }, brain: { provider: 'p', model: 'm' }, vision: { provider: 'p', model: 'm' } },
    }) as EngineSettings,
};

const content = { academicLessons: async () => [], installed: async () => ({}) } as unknown as ContentStore;
const identity = async () => PROFILE;

const harness = async (prefix: string) => {
  const store = await vault(prefix);
  const sources = new SourceIngestor(store, identity);
  const vaultView = new BrainVault(store.root);
  await vaultView.init();
  const brain = new BrainService(content, vaultView, settings, await tempRoot(`${prefix}-quizzes`), { wiki: store, sources, identity });
  return { store, sources, brain };
};

const claim = (over: Partial<WikiClaim>): WikiClaim => ({
  id: `claim-${Math.random().toString(36).slice(2, 10)}`,
  text: 'Force changes momentum.',
  kind: 'source_fact',
  origin: 'student',
  status: 'current',
  citations: [],
  supersedes: [],
  ...over,
});

const citation = (sourceId: string, sourceRevision: string, sha256: string): SourceCitation => ({
  sourceId,
  sourceRevision,
  sha256,
  locator: { kind: 'text', start: 0, end: 4 },
});

const session = (turns: Session['turns'], over: Partial<Session> = {}): Session => ({
  id: 'sess-save',
  teacher: 'guide',
  startedAt: T0,
  updatedAt: T0,
  turns,
  lessonIds: [],
  sources: [],
  ingestedTurns: 0,
  ...over,
});

test('the index counts pages and sources and lists a catalogue row per compiled page', async () => {
  const store = await vault('q-index');
  const { record, bytes } = sourceFixture('source-note', 'Transcribed note.');
  await store.putSource(record, bytes);
  await store.applyProposal(
    proposal([{ op: 'upsert_page', page: conceptDraft('damping') }, { op: 'upsert_page', page: synthesisDraft('force-synthesis', ['source-note']) }], {
      damping: null,
      'force-synthesis': null,
    }),
  );

  const index = await new WikiQuery(store).index();
  assert.equal(index.counts.pages, 2);
  assert.equal(index.counts.sources, 1);
  assert.equal(index.counts.byKind.concept, 1);
  assert.equal(index.counts.byKind.synthesis, 1);
  const row = index.pages.find((page) => page.id === 'force-synthesis');
  assert.equal(row?.kind, 'synthesis');
  assert.deepEqual(row?.sourceIds, ['source-note']);
  assert.match(row?.revision ?? '', /^rev-/);
});

test('search finds the compiled page, so a repeated question reuses the saved synthesis', async () => {
  const store = await vault('q-search');
  const { record, bytes } = sourceFixture('source-note', 'Transcribed note.');
  await store.putSource(record, bytes);
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('damping', { markdown: 'A damped oscillator loses amplitude each cycle.' }) },
        {
          op: 'upsert_page',
          page: synthesisDraft('impulse-momentum-synthesis', ['source-note'], {
            title: 'How impulse and momentum connect',
            summary: 'The worked answer: impulse is force summed over time, and it equals the change in momentum.',
            markdown: 'Impulse is force summed over a collision interval; it equals the change in momentum.',
          }),
        },
      ],
      { damping: null, 'impulse-momentum-synthesis': null },
    ),
  );

  const hits = (await new WikiQuery(store).search('how do impulse and momentum relate')).hits;
  assert.equal(hits[0]?.id, 'impulse-momentum-synthesis', 'the saved synthesis is the worked answer the repeat finds');
  assert.equal(hits[0]?.kind, 'synthesis');
  assert.equal(hits[0]?.match, 'keyword');
  const nothing = await new WikiQuery(store).search('zqx wobble');
  assert.deepEqual(nothing.hits, [], 'nothing real, nothing returned');
  assert.equal(nothing.searchMode, 'keyword_only', 'no embed lane means the honest keyword mode');
  assert.deepEqual((await new WikiQuery(store).search('')).hits, []);
});

test('the semantic lane admits pages keyword scoring missed, and marks how each was found', async () => {
  const store = await vault('q-hybrid');
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('damping', { markdown: 'A damped oscillator loses amplitude each cycle.' }) },
        { op: 'upsert_page', page: conceptDraft('resonance', { title: 'Resonant driving', summary: 'Amplitude builds at the natural frequency.' }) },
      ],
      { damping: null, resonance: null },
    ),
  );

  // The lane answers a cosine map over the corpus keys; 'damping' is admitted even though
  // the query shares no search terms with it — that is what the lane is for.
  const embed = async () => new Map([['damping@rev-1', 0.9]]);
  const found = await new WikiQuery(store, embed).search('energy loss in oscillators');
  assert.equal(found.searchMode, 'hybrid');
  assert.equal(found.hits[0]?.id, 'damping');
  assert.equal(found.hits[0]?.match, 'semantic');

  const down = await new WikiQuery(store, async () => null).search('energy loss in oscillators');
  assert.equal(down.searchMode, 'keyword_only');
  assert.deepEqual(down.hits, [], 'a semantic-only page is honestly absent when the lane is down');
});

test('a page view judges every claim live against the current source catalogue', async () => {
  const store = await vault('q-view');
  const { record, bytes } = sourceFixture('source-note', 'notes');
  await store.putSource(record, bytes);
  const cited = citation('source-note', record.revision, record.sha256);
  const stale = citation('source-note', 'rev-0', record.sha256);
  const missing = citation('source-gone', 'rev-1', record.sha256);
  const modelClaim = claim({ origin: 'model', citations: [cited], text: 'A model said so.' });
  const studentClaim = claim({ citations: [cited], text: 'Force changes momentum.' });
  const staleClaim = claim({ citations: [stale], text: 'An older reading.' });
  const missingClaim = claim({ citations: [missing], text: 'A citation to nothing.' });
  const questionClaim = claim({ kind: 'question', citations: [], text: 'Why does amplitude decay?' });

  await store.applyProposal(
    proposal(
      [
        {
          op: 'upsert_page',
          page: conceptDraft('damping', {
            claims: [modelClaim, studentClaim, staleClaim, missingClaim, questionClaim],
          }),
        },
        { op: 'upsert_page', page: synthesisDraft('answer-page', ['source-note', 'source-gone']) },
      ],
      { damping: null, 'answer-page': null },
    ),
  );

  const view = await new WikiQuery(store).pageView('damping');
  assert.ok(view);
  const by = (text: string) => view!.claims.find((c) => c.text === text);
  assert.equal(by('Force changes momentum.')?.assertable, true);
  assert.equal(by('A model said so.')?.assertable, false);
  assert.equal(by('A model said so.')?.reason, 'foreign_origin');
  assert.equal(by('An older reading.')?.reason, 'superseded_source');
  assert.equal(by('A citation to nothing.')?.reason, 'unresolved_source');
  assert.equal(by('Why does amplitude decay?')?.reason, 'open_question');

  const synthesis = await new WikiQuery(store).pageView('answer-page');
  assert.deepEqual(synthesis?.missingSourceIds, ['source-gone'], 'a rested-on source that no longer exists is shown, not hidden');
  assert.deepEqual(synthesis?.sources.map((s) => s.id), ['source-note']);
});

test('read_wiki_page feeds a generated page to the evidence set as withheld, never assertable', async () => {
  const store = await vault('q-tool');
  const { record, bytes } = sourceFixture('source-note', 'notes');
  await store.putSource(record, bytes);
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('damping') },
        { op: 'upsert_page', page: synthesisDraft('worked-answer', ['source-note'], { markdown: 'A model-derived worked answer.' }) },
      ],
      { damping: null, 'worked-answer': null },
    ),
  );

  const deps = {
    content: { supportLessons: async () => [], academicLessons: async () => [] } as unknown as ContentStore,
    brain: { page: async () => null, weakest: async () => [] } as unknown as BrainService,
    searxngUrl: '',
    wiki: store,
  };

  // The Friend has no wiki capabilities at all — asking is a visible refusal, not silence.
  const friend = new TurnContext(() => {});
  const refused = (await (buildTools('friend', deps, friend)['read_wiki_page'] as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ pageId: 'damping' })) as {
    refused: boolean;
    capability: string;
  };
  assert.equal(refused.refused, true);
  assert.equal(refused.capability, 'tool:read_wiki_page');

  const ctx = new TurnContext(() => {});
  const read = buildTools('guide', deps, ctx)['read_wiki_page'] as unknown as { execute: (i: unknown) => Promise<unknown> };

  const synthesis = (await read.execute({ pageId: 'worked-answer' })) as { kind: string; provenance?: string };
  assert.equal(synthesis.kind, 'synthesis');
  assert.match(synthesis.provenance ?? '', /never assert/i);
  assert.equal(ctx.withheldSourceIds.has('brain:worked-answer'), true);

  const evidence = buildEvidenceSet({ sources: [...ctx.sources.values()], evidenceText: ctx.evidenceText, withheldSources: ctx.withheldSourceIds });
  const item = evidence.items.find((i) => i.id === 'worked-answer');
  assert.equal(item?.assertable, false, 'generated prose can be named but never asserted as evidence');
  assert.match(item?.withheldReason ?? '', /generated page/);

  // A concept page is the student's own compiled knowledge — it stays assertable.
  const ctx2 = new TurnContext(() => {});
  const read2 = buildTools('guide', deps, ctx2)['read_wiki_page'] as unknown as { execute: (i: unknown) => Promise<unknown> };
  await read2.execute({ pageId: 'damping' });
  assert.equal(ctx2.withheldSourceIds.has('brain:damping'), false);
});

test('saveAnswer freezes the turn as a model-provenance answer source — no page is written', async () => {
  const { store, brain } = await harness('q-save');
  const s = session([
    { role: 'user', content: 'What is impulse?', at: T0 },
    {
      role: 'assistant',
      content: 'Impulse is force over a time interval.',
      at: T0,
      verification: {
        model: 'gemma4:e4b',
        provider: 'ollama',
        sources: [{ kind: 'lesson', id: 'damped', title: 'Damped Oscillations', courseName: 'Mechanics', cited: true }],
        checks: [],
        toolCalls: [{ tool: 'search_lessons', summary: '"impulse" → 1 lesson' }],
      },
    },
  ]);

  const saved = await brain.saveAnswer(s, { turnIndex: 1 });
  const record = await store.readSource(saved.source.id);
  assert.equal(record?.kind, 'answer');
  if (record?.kind !== 'answer') assert.fail('expected an answer source');
  assert.equal(record.origin, 'model', 'a saved answer is model provenance — it can never masquerade as student evidence');
  assert.deepEqual(record.session, { sessionId: 'sess-save', teacher: 'guide', firstTurn: 1, lastTurn: 1 });
  assert.match(record.attribution.creator ?? '', /Guide/);

  const text = await store.readExtractionText(saved.source.id);
  assert.match(text ?? '', /Impulse is force over a time interval\./);
  assert.match(text ?? '', /\[lesson\] damped — Damped Oscillations/, 'the sources the answer drew on are preserved verbatim');
  assert.match(text ?? '', /search_lessons/, 'the tool trace is preserved too');

  assert.equal((await store.listPages()).length, 0, 'saving never writes a page — the proposal pipeline is the only path');
  const job = await store.readJob(saved.jobId);
  assert.ok(job, 'the job is queued so a compile can file the proposal');
  assert.deepEqual(job?.sourceIds, [record?.id]);
});

test('saveAnswer resolves the answer the student saw even when the index drifted', async () => {
  const { store, brain } = await harness('q-save-drift');
  const s = session([
    { role: 'user', content: 'First?', at: T0 },
    { role: 'assistant', content: 'First answer.', at: T0 },
    { role: 'user', content: 'Second?', at: T0 },
    { role: 'assistant', content: 'Second answer.', at: T0 },
  ]);

  // The UI's index points past the stored turns (a failed turn drifted it) — content wins.
  const saved = await brain.saveAnswer(s, { turnIndex: 9, content: 'Second answer.' });
  const record = await store.readSource(saved.source.id);
  assert.equal(record?.kind, 'answer');
  if (record?.kind !== 'answer') assert.fail('expected an answer source');
  assert.equal(record.session.firstTurn, 3, 'the matching stored turn is saved, not the drifted index');

  await assert.rejects(() => brain.saveAnswer(s, { turnIndex: 0 }), SourceRejection, 'a user turn cannot be saved as an answer');
  await assert.rejects(() => brain.saveAnswer(s, { turnIndex: 9 }), SourceRejection, 'a missing index with no content match is refused');
});

test('an answer source cannot be filed as anything but model provenance', async () => {
  const store = await vault('q-answer-origin');
  const sources = new SourceIngestor(store, identity);
  const sessionRef = { sessionId: 'sess-1', teacher: 'guide' as const, firstTurn: 0, lastTurn: 1 };
  await assert.rejects(
    () => sources.ingest({ kind: 'answer', title: 'A', mediaType: 'text/markdown', bytes: Buffer.from('x'), session: sessionRef, origin: 'student' }),
    (error: unknown) => error instanceof SourceRejection && (error as SourceRejection).code === 'origin_mismatch',
  );
  const kept = await sources.ingest({ kind: 'answer', title: 'A', mediaType: 'text/markdown', bytes: Buffer.from('x'), session: sessionRef });
  assert.equal((await store.readSource(kept.source.id))?.origin, 'model');
});

test('restore writes the old revision as a new one and keeps the history it replaced', async () => {
  const { store, brain } = await harness('q-restore');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { summary: 'First version.', markdown: 'First body.' }) }], { damping: null }));
  const first = await store.readPage('damping');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { summary: 'Second version.', markdown: 'Second body.' }) }], { damping: first?.revision ?? '' }));
  const second = await store.readPage('damping');

  const accepted = await brain.restorePageRevision('damping', first?.revision ?? '', second?.revision ?? '');
  assert.equal(accepted.report.committed, true);
  assert.equal(accepted.report.pages[0]?.change, 'updated');

  const restored = await store.readPage('damping');
  assert.equal(restored?.metadata?.summary, 'First version.');
  assert.equal(restored?.body, 'First body.');
  assert.notEqual(restored?.revision, first?.revision, 'the restore is its own revision, not a rewind');

  const revisions = await store.pageRevisions('damping');
  assert.equal(revisions?.revisions.length, 3, 'first, second and the restore are all kept');
  const stillThere = await store.readPageRevision('damping', first?.revision ?? '');
  assert.match(stillThere?.raw ?? '', /First body\./, 'the historical snapshot is preserved verbatim');

  const log = await store.readLog();
  assert.equal(log[0]?.kind, 'wiki');
  assert.match(log[0]?.title ?? '', /restored/i);
});

test('a restore on a stale base revision refuses 409-style and writes nothing', async () => {
  const { store, brain } = await harness('q-restore-stale');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const page = await store.readPage('damping');

  await assert.rejects(
    () => brain.restorePageRevision('damping', page?.revision ?? '', 'rev-somebody-else'),
    (error: unknown) => {
      assert.equal(error instanceof VaultConflictError, true);
      assert.deepEqual((error as VaultConflictError).details, [{ id: 'damping', expected: 'rev-somebody-else', found: page?.revision, reason: 'revision_changed' }]);
      return true;
    },
  );
  assert.equal((await store.pageRevisions('damping'))?.revisions.length, 1, 'a refused restore leaves history untouched');

  await assert.rejects(
    () => brain.restorePageRevision('damping', 'rev-never-was', page?.revision ?? ''),
    (error: unknown) => error instanceof SourceRejection && (error as SourceRejection).status === 404,
  );
});
