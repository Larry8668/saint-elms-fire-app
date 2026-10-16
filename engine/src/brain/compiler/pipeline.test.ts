import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineSettings } from '@sef/shared';
import type { ContentStore } from '../../content/store';
import type { SettingsReader } from '../../settings/store';
import type { Session } from '../../sessions/store';
import { PROFILE, T0, tempRoot, vault } from '../testing/fixtures';
import { evidenceResolver } from '../evidence';
import { BrainService } from '../service';
import { SourceIngestor } from '../sources/ingest';
import { BrainVault } from '../vault';
import { VaultConflictError, VaultSchemaError } from '../vault-errors';
import { WikiCompiler, JobConflictError, ProposalStateError } from './compile';
import type { KeeperDraft } from './draft';
import { readProposalRecord } from '../proposals';

/** Deterministic settings: resolveModel only builds config, never calls a provider. */
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

const harness = async (prefix: string, propose: (prompt: string) => Promise<KeeperDraft>) => {
  const store = await vault(prefix);
  const sources = new SourceIngestor(store, identity);
  const compiler = new WikiCompiler(store, { settings, content, profile: identity, propose });
  return { store, sources, compiler };
};

const ingestNote = (sources: SourceIngestor, text: string, title = 'Lecture notes') =>
  sources.ingest({ kind: 'note', title, mediaType: 'text/markdown', bytes: Buffer.from(text, 'utf8') });

const draft = (over: Partial<KeeperDraft> = {}): KeeperDraft => ({ pages: [], links: [], ...over });

const pageDraft = (over: Partial<KeeperDraft['pages'][number]> = {}): KeeperDraft['pages'][number] => ({
  title: 'Momentum',
  kind: 'concept',
  summary: 'What momentum says now.',
  markdown: '# Momentum\n\nForce changes momentum.',
  claims: [],
  ...over,
});

test('a note compiles to a pending proposal which commits through the journal when accepted', async () => {
  const { store, sources, compiler } = await harness('pipe-accept', async () =>
    draft({
      pages: [
        pageDraft({
          claims: [{ text: 'Force changes momentum', kind: 'source_fact', quote: 'Force changes momentum over time.' }],
        }),
      ],
    }),
  );
  const { jobId } = await ingestNote(sources, 'Force changes momentum over time.');

  const compiled = await compiler.compileJob(jobId);
  assert.equal(compiled.job.stage, 'awaiting_review');
  assert.ok(compiled.proposalId);
  const record = await readProposalRecord(store.root, compiled.proposalId!);
  assert.equal(record?.state, 'pending');
  assert.equal(record?.jobId, jobId);

  const { report } = await compiler.accept(compiled.proposalId!);
  assert.equal(report.pages[0]?.change, 'created');
  const job = await store.readJob(jobId);
  assert.equal(job?.stage, 'committed');

  const page = await store.readPage(report.pages[0]!.id);
  assert.equal(page?.metadata?.title, 'Momentum');
  const claim = page?.metadata?.claims.find((c) => c.text === 'Force changes momentum');
  assert.ok(claim, 'the drafted claim landed on the page');
  assert.equal(claim!.status, 'current');
  assert.equal(claim!.origin, 'student');
  assert.equal(claim!.citations[0]?.locator.kind, 'text');
});

test('a second source extends the page instead of replacing what the first established', async () => {
  const drafts = [
    draft({
      pages: [
        pageDraft({
          claims: [
            { text: 'Force changes momentum over time', kind: 'source_fact', quote: 'Force changes momentum over time.' },
            { text: 'Impulse is force times duration', kind: 'source_fact', quote: 'Impulse is force times duration.' },
          ],
        }),
      ],
    }),
    draft({
      pages: [
        pageDraft({
          // The model proposes only what B adds; it must not (and cannot) drop A's claim.
          markdown: '# Momentum\n\nForce changes momentum; impulse generalises it.',
          claims: [{ text: 'Impulse sums force over a collision', kind: 'source_fact', quote: 'Impulse sums force over a collision.' }],
        }),
      ],
    }),
  ];
  let turn = 0;
  const { store, sources, compiler } = await harness('pipe-cumulative', async () => drafts[turn++]!);

  const a = await ingestNote(sources, 'Force changes momentum over time. Impulse is force times duration.', 'Source A');
  const first = await compiler.compileJob(a.jobId);
  await compiler.accept(first.proposalId!);
  const pageId = first.proposalId ? (await readProposalRecord(store.root, first.proposalId))?.proposal.operations[0] : null;
  assert.ok(pageId && pageId.op === 'upsert_page');
  const existingId = pageId.page.id;

  const b = await ingestNote(sources, 'Impulse sums force over a collision.', 'Source B');
  const second = await compiler.compileJob(b.jobId);
  // The draft named the existing page's id? It did not — title matching resolves it.
  const upsert = second.proposalId ? (await readProposalRecord(store.root, second.proposalId))!.proposal.operations.find((op) => op.op === 'upsert_page') : null;
  assert.ok(upsert && upsert.op === 'upsert_page');
  assert.equal(upsert.page.id, existingId);
  assert.ok(second.proposalId && (await readProposalRecord(store.root, second.proposalId))!.proposal.baseRevisions[existingId]);

  await compiler.accept(second.proposalId!);
  const page = await store.readPage(existingId);
  const texts = page?.metadata?.claims.map((claim) => claim.text) ?? [];
  assert.ok(texts.includes('Force changes momentum over time'), 'source A survives source B');
  assert.ok(texts.includes('Impulse is force times duration'), 'source A survives source B');
  assert.ok(texts.includes('Impulse sums force over a collision'), 'source B is incorporated');
});

test('a claim that contradicts an established one lands as a dispute, both kept and cited', async () => {
  const drafts = [
    draft({ pages: [pageDraft({ claims: [{ text: 'Damping lowers the resonant frequency', kind: 'source_fact', quote: 'Damping lowers the resonant frequency.' }], markdown: '# Momentum\n\nDamping lowers the resonant frequency.' })] }),
    draft({ pages: [pageDraft({ claims: [{ text: 'Damping raises the resonant frequency', kind: 'source_fact', quote: 'Damping raises the resonant frequency.' }] })] }),
  ];
  let turn = 0;
  const { store, sources, compiler } = await harness('pipe-dispute', async () => drafts[turn++]!);

  const a = await ingestNote(sources, 'Damping lowers the resonant frequency.', 'A');
  await compiler.accept((await compiler.compileJob(a.jobId)).proposalId!);
  const pageId = (await store.listPages())[0]!.id;

  const b = await ingestNote(sources, 'Damping raises the resonant frequency.', 'B');
  const second = await compiler.compileJob(b.jobId);
  await compiler.accept(second.proposalId!);

  const page = await store.readPage(pageId);
  const lower = page?.metadata?.claims.find((c) => c.text === 'Damping lowers the resonant frequency');
  const raise = page?.metadata?.claims.find((c) => c.text === 'Damping raises the resonant frequency');
  assert.ok(lower && raise, 'both sides of the contradiction are on the page');
  assert.equal(lower!.status, 'disputed');
  assert.equal(raise!.status, 'disputed');
  assert.ok(raise!.supersedes.includes(lower!.id) || raise!.citations.length > 0, 'the dispute is explicit, not silent');
});

test('claims the sources do not literally say are dropped, with reasons', async () => {
  const { store, sources, compiler } = await harness('pipe-unsupported', async () =>
    draft({
      pages: [
        pageDraft({
          claims: [
            { text: 'Momentum is always conserved', kind: 'source_fact', quote: 'the model paraphrased this, it is not verbatim' },
            { text: 'Momentum is conserved', kind: 'source_fact', quote: 'Momentum is conserved in closed systems.' },
            { text: 'Energy probably hides somewhere', kind: 'deduction' },
          ],
        }),
      ],
    }),
  );
  const { jobId } = await ingestNote(sources, 'Momentum is conserved in closed systems.');
  const compiled = await compiler.compileJob(jobId);

  assert.ok(compiled.dropped.some((drop) => drop.what === 'Momentum is always conserved'));
  await compiler.accept(compiled.proposalId!);
  const page = (await store.listPages())[0]!;
  const texts = page.metadata?.claims.map((c) => c.text) ?? [];
  assert.ok(texts.includes('Momentum is conserved'));
  assert.ok(texts.includes('Energy probably hides somewhere'));
  assert.equal(page.metadata?.claims.find((c) => c.kind === 'deduction')?.origin, 'model');
});

test('a link the student never stated is filed as suggested, not student-made', async () => {
  const { store, sources, compiler } = await harness('pipe-links', async () =>
    draft({
      pages: [pageDraft({}), pageDraft({ title: 'Energy', summary: 'Energy in the system.', markdown: '# Energy', claims: [] })],
      links: [
        { from: 'Momentum', to: 'Energy', type: 'related_to', why: 'They share mechanics', quote: 'the student never said this' },
        { from: 'Momentum', to: 'Energy', type: 'builds_upon', why: 'Student made this link', quote: 'momentum builds on energy for me' },
      ],
    }),
  );
  const { jobId } = await ingestNote(sources, 'Momentum and energy. Note: momentum builds on energy for me, I think.');
  const compiled = await compiler.compileJob(jobId);
  await compiler.accept(compiled.proposalId!);

  const momentum = (await store.listPages()).find((page) => page.metadata?.title === 'Momentum');
  const links = momentum?.metadata?.links ?? [];
  const suggested = links.find((link) => link.type === 'related_to');
  const studentMade = links.find((link) => link.type === 'builds_upon');
  assert.equal(suggested?.origin, 'suggested');
  assert.equal(studentMade?.origin, 'student');
  assert.ok(studentMade!.citations.length > 0, 'a student-origin link cites the actual statement');
});

test('a stale proposal is refused by the revision check, not applied anyway', async () => {
  const { store, sources, compiler } = await harness('pipe-stale', async () => draft({ pages: [pageDraft()] }));
  const first = await compiler.compileJob((await ingestNote(sources, 'Momentum first pass.')).jobId);
  const second = await compiler.compileJob((await ingestNote(sources, 'Momentum second pass.')).jobId);
  // Both drafts create "momentum" (the page did not exist yet), so both expect base null.
  await compiler.accept(second.proposalId!);
  // Accepting the first now would create the page over the page that just landed.
  await assert.rejects(() => compiler.accept(first.proposalId!), VaultConflictError);
  // The refused proposal stays pending — the conflict is a state, not a silent mutation.
  assert.equal((await readProposalRecord(store.root, first.proposalId!))?.state, 'pending');
});

test('rejecting a proposal changes no pages and marks the job cancelled', async () => {
  const { store, sources, compiler } = await harness('pipe-reject', async () => draft({ pages: [pageDraft()] }));
  const { jobId } = await ingestNote(sources, 'Momentum material.');
  const compiled = await compiler.compileJob(jobId);
  await compiler.reject(compiled.proposalId!, 'not this one');

  assert.equal((await store.readJob(jobId))?.stage, 'cancelled');
  assert.equal((await store.listPages()).length, 0, 'a rejected proposal writes nothing');
  assert.equal((await readProposalRecord(store.root, compiled.proposalId!))?.state, 'rejected');
  await assert.rejects(() => compiler.accept(compiled.proposalId!), ProposalStateError);
  await assert.rejects(() => compiler.reject(compiled.proposalId!), ProposalStateError);
});

test('a draft that yields nothing closes the job as no_changes, not failed', async () => {
  const { store, sources, compiler } = await harness('pipe-empty', async () => draft());
  const { jobId } = await ingestNote(sources, 'Nothing worth keeping.');
  const compiled = await compiler.compileJob(jobId);
  assert.equal(compiled.job.stage, 'no_changes');
  assert.equal(compiled.proposalId, null);
  assert.equal((await store.listPages()).length, 0);
});

test('a failed compile leaves the job failed with a reason, and retry requeues it', async () => {
  let calls = 0;
  const { store, sources, compiler } = await harness('pipe-retry', async () => {
    calls += 1;
    if (calls === 1) throw new Error('model unavailable');
    return draft({ pages: [pageDraft()] });
  });
  const { jobId } = await ingestNote(sources, 'Retry me.');
  await assert.rejects(() => compiler.compileJob(jobId));
  const failed = await store.readJob(jobId);
  assert.equal(failed?.stage, 'failed');
  assert.ok(failed?.error, 'failed jobs say why');

  await sources.retry(jobId);
  assert.equal((await store.readJob(jobId))?.stage, 'queued');

  const second = await compiler.compileJob(jobId);
  assert.equal(second.job.stage, 'awaiting_review');
});

test('jobs and proposals belonging to another profile are invisible', async () => {
  const { sources, compiler } = await harness('pipe-foreign', async () => draft());
  const { jobId } = await ingestNote(sources, 'Private.');
  const foreign = new WikiCompiler((await vault('pipe-foreign-b')), {
    settings,
    content,
    profile: async () => ({ ...PROFILE, studentId: 'student-b' }),
    propose: async () => draft(),
  });
  await assert.rejects(() => foreign.compileJob(jobId), JobConflictError);
});

test('compiled pages read back through the legacy vault as concept views', async () => {
  const { store, sources, compiler } = await harness('pipe-view', async () =>
    draft({
      pages: [
        pageDraft({
          learner: { inMyWords: 'Force is a push or a pull that changes motion.' },
          claims: [{ text: 'Force changes momentum', kind: 'student_belief', quote: 'Force changes momentum, I get that now.' }],
        }),
      ],
    }),
  );
  const { jobId } = await ingestNote(sources, 'Force changes momentum, I get that now.');
  const compiled = await compiler.compileJob(jobId);
  await compiler.accept(compiled.proposalId!);

  const vaultView = new BrainVault(store.root, evidenceResolver(await tempRoot('pipe-quizzes'), store));
  await vaultView.init();
  const pages = await vaultView.all();
  assert.equal(pages.size, 1);
  const view = pages.get('momentum')!;
  assert.equal(view.concept, 'Momentum');
  assert.equal(view.sections.in_my_words, 'Force is a push or a pull that changes motion.');
  // The student-authored source the learner block drew on is registered as evidence.
  assert.ok(view.evidence.some((e) => e.kind === 'capture'), 'the student source resolves to evidence');
});

test('the legacy save path refuses to clobber a typed page', async () => {
  const { store, sources, compiler } = await harness('pipe-guard', async () => draft({ pages: [pageDraft()] }));
  const { jobId } = await ingestNote(sources, 'Momentum.');
  const compiled = await compiler.compileJob(jobId);
  await compiler.accept(compiled.proposalId!);

  const vaultView = new BrainVault(store.root);
  await vaultView.init();
  const view = (await vaultView.all()).get('momentum')!;
  await assert.rejects(() => vaultView.save(view), VaultSchemaError);
});

test('Reflect on a session freezes exactly the new turns and checkpoints them', async () => {
  const store = await vault('pipe-session');
  const sources = new SourceIngestor(store, identity);
  const compiler = new WikiCompiler(store, {
    settings,
    content,
    profile: identity,
    propose: async () => draft({ pages: [pageDraft({ title: 'Impulse' })] }),
  });
  const vaultView = new BrainVault(store.root);
  await vaultView.init();
  const quizzesDir = await tempRoot('pipe-quizzes');
  const brain = new BrainService(content, vaultView, settings, quizzesDir, { wiki: store, sources, compiler, identity });

  const session: Session = {
    id: 'sess-1',
    teacher: 'guide',
    startedAt: T0,
    updatedAt: T0,
    turns: [
      { role: 'user', content: 'What is impulse?', at: T0 },
      { role: 'assistant', content: 'Force over time.', at: T0 },
      { role: 'user', content: 'And momentum?', at: T0 },
    ],
    lessonIds: [],
    sources: [],
    ingestedTurns: 1, // the first turn was ingested before — only the last two are fresh
  };
  const result = await brain.ingestSession(session);
  assert.equal(result.stage, 'committed');
  assert.equal(result.consumedTurns, 3, 'the checkpoint covers the committed range');
  assert.ok(result.proposalId);

  const record = await readProposalRecord(store.root, result.proposalId!);
  const sessionSource = record?.proposal.sourceIds[0];
  const source = sessionSource ? await store.readSource(sessionSource) : null;
  assert.equal(source?.kind, 'session');
  assert.equal(source?.session?.firstTurn, 1);
  assert.equal(source?.session?.lastTurn, 2);
});
