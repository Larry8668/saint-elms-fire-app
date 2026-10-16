import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CompileResult, EngineSettings, ProposalAcceptance, SourceReceipt, WikiIndex, WikiPageView } from '@sef/shared';
import type { ContentStore } from '../../content/store';
import type { SettingsReader } from '../../settings/store';
import { SessionStore, type Session } from '../../sessions/store';
import { WikiCompiler } from '../../brain/compiler/compile';
import type { KeeperDraft } from '../../brain/compiler/draft';
import { BrainService } from '../../brain/service';
import { SourceIngestor } from '../../brain/sources/ingest';
import { BrainVault } from '../../brain/vault';
import { conceptDraft, PROFILE, proposal, T0, tempRoot, vault } from '../../brain/testing/fixtures';
import type { WikiStore } from '../../brain/wiki-store';
import { sourceRoutes } from './sources';
import { studentRoutes } from './student';
import { wikiRoutes } from './wiki';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-wiki-routes-'));

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
const AUTH = { authorization: 'Bearer valid', 'content-type': 'application/json' };
const draft = (over: Partial<KeeperDraft> = {}): KeeperDraft => ({ pages: [], links: [], ...over });
const pageDraft = (over: Partial<KeeperDraft['pages'][number]> = {}): KeeperDraft['pages'][number] => ({
  title: 'Impulse, worked',
  kind: 'synthesis',
  summary: 'The worked answer: impulse is force summed over time.',
  markdown: 'Impulse is force summed over a collision interval; it equals the change in momentum.',
  claims: [],
  ...over,
});

async function harness(prefix: string, opts: { propose?: (prompt: string) => Promise<KeeperDraft>; studentId?: string; store?: WikiStore } = {}) {
  const identity = { ...PROFILE, studentId: opts.studentId ?? PROFILE.studentId };
  const store = opts.store ?? (await vault(prefix));
  const sources = new SourceIngestor(store, async () => identity);
  const compiler = new WikiCompiler(store, { settings, content, profile: async () => identity, propose: opts.propose });
  const sessions = new SessionStore(await tempRoot(`${prefix}-sessions`));
  const vaultView = new BrainVault(store.root);
  await vaultView.init();
  const brain = new BrainService(content, vaultView, settings, await tempRoot(`${prefix}-quizzes`), { wiki: store, sources, identity: async () => identity });
  const profile = { id: identity.studentId, name: 'Student', email: 's@example.test', cohortId: 'cohort-a' };
  const ws = { profile, sources, compiler, wiki: store, brain, sessions };
  const deps = {
    settings: {},
    auth: { resolve: async (token: string) => (token === 'valid' ? { profile, mode: 'offline' as const } : null) },
    workspaces: { get: async () => ws },
  } as never;
  return { store, sources, sessions, brain, wiki: wikiRoutes(deps), student: studentRoutes(deps), contribution: sourceRoutes(deps) };
}

const post = (app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response }, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: AUTH, body: body === undefined ? undefined : JSON.stringify(body) });

const session = (turns: Session['turns'], id = 'sess-http'): Session => ({
  id,
  teacher: 'guide',
  startedAt: T0,
  updatedAt: T0,
  turns,
  lessonIds: [],
  sources: [],
  ingestedTurns: 0,
});

test('the wiki catalogue and one page are served over HTTP', async () => {
  const { store, wiki } = await harness('route-wiki-index');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));

  const index = await wiki.request('/wiki/pages', { headers: AUTH });
  assert.equal(index.status, 200);
  const body = (await index.json()) as WikiIndex;
  assert.equal(body.counts.pages, 1);
  assert.equal(body.pages[0]?.id, 'damping');
  assert.equal(body.pages[0]?.state, 'ok');

  const page = await wiki.request('/wiki/pages/damping', { headers: AUTH });
  assert.equal(page.status, 200);
  const view = (await page.json()) as WikiPageView;
  assert.equal(view.kind, 'concept');
  assert.match(view.body, /Force changes momentum/);

  assert.equal((await wiki.request('/wiki/pages/nothing-here', { headers: AUTH })).status, 404);
  assert.equal((await wiki.request('/wiki/pages', { headers: { 'content-type': 'application/json' } })).status, 401, 'unauthenticated is refused');
});

test('save → compile → accept writes a synthesis page the wiki index then lists', async () => {
  const { wiki, contribution, sessions, store } = await harness('route-wiki-save', {
    propose: async () => draft({ pages: [pageDraft()] }),
  });
  await sessions.put(
    session([
      { role: 'user', content: 'What is impulse?', at: T0 },
      {
        role: 'assistant',
        content: 'Impulse is force summed over a collision interval.',
        at: T0,
        verification: { model: 'gemma4:e4b', provider: 'ollama', sources: [], checks: [], toolCalls: [] },
      },
    ]),
  );

  const saved = await post(wiki, '/wiki/save', { sessionId: 'sess-http', turnIndex: 1 });
  assert.equal(saved.status, 201);
  const receipt = (await saved.json()) as SourceReceipt;
  assert.equal(receipt.source.kind, 'answer');
  assert.equal(receipt.source.title.includes('Impulse') || receipt.source.title.length > 0, true);

  // The save left a job, not a page — the proposal pipeline is still the only writer.
  assert.equal((await store.listPages()).length, 0);
  const compiled = await post(contribution, `/sources/${receipt.jobId}/compile`, {});
  assert.equal(compiled.status, 200);
  const result = (await compiled.json()) as CompileResult;
  assert.equal(result.job.stage, 'awaiting_review');
  assert.ok(result.proposalId);

  const accepted = await post(contribution, `/proposals/${result.proposalId}/accept`, {});
  assert.equal(accepted.status, 200);

  const index = await wiki.request('/wiki/pages', { headers: AUTH });
  const body = (await index.json()) as WikiIndex;
  assert.equal(body.counts.byKind.synthesis, 1, 'the accepted synthesis is now a compiled page a repeat query can reuse');
});

test('save rejects a user turn, a missing session and a malformed body honestly', async () => {
  const { wiki, sessions } = await harness('route-wiki-save-bad');
  await sessions.put(session([{ role: 'user', content: 'Only a question.', at: T0 }], 'sess-user-only'));

  const notAnswer = await post(wiki, '/wiki/save', { sessionId: 'sess-user-only', turnIndex: 0 });
  assert.equal(notAnswer.status, 400);
  assert.equal(((await notAnswer.json()) as { code: string }).code, 'not_an_answer');

  assert.equal((await post(wiki, '/wiki/save', { sessionId: 'sess-user-only' })).status, 400, 'no assistant turn at all');
  assert.equal((await post(wiki, '/wiki/save', { sessionId: 'sess-missing' })).status, 404);
  assert.equal((await post(wiki, '/wiki/save', { turnIndex: 0 })).status, 400, 'no sessionId at all');
});

test('restore over HTTP: the named revision becomes the new one; a stale base is a 409', async () => {
  const { store, student } = await harness('route-wiki-restore');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { summary: 'First version.', markdown: 'First body.' }) }], { damping: null }));
  const first = await store.readPage('damping');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping', { summary: 'Second version.', markdown: 'Second body.' }) }], { damping: first?.revision ?? '' }));
  const second = await store.readPage('damping');

  const stale = await post(student, '/brain/pages/damping/restore', { revision: first?.revision, baseRevision: 'rev-not-current' });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, 'stale_revision');

  const restored = await post(student, '/brain/pages/damping/restore', { revision: first?.revision, baseRevision: second?.revision });
  assert.equal(restored.status, 200);
  const acceptance = (await restored.json()) as ProposalAcceptance;
  assert.equal(acceptance.report.committed, true);
  assert.equal((await store.readPage('damping'))?.metadata?.summary, 'First version.');
  assert.equal((await store.pageRevisions('damping'))?.revisions.length, 3, 'every revision is kept');

  assert.equal((await post(student, '/brain/pages/nothing/restore', { revision: 'rev-1', baseRevision: 'rev-1' })).status, 404);
  assert.equal((await post(student, '/brain/pages/damping/restore', { revision: 'rev-never', baseRevision: (await store.readPage('damping'))?.revision })).status, 404);
  assert.equal((await post(student, '/brain/pages/damping/restore', {})).status, 400, 'a body without revision and baseRevision is refused');
});

test('another profile cannot save into or restore this workspace — 404, not leakage', async () => {
  const mine = await harness('route-wiki-mine');
  await mine.sessions.put(session([{ role: 'user', content: 'q', at: T0 }, { role: 'assistant', content: 'a', at: T0 }], 'sess-private'));
  await mine.store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const page = await mine.store.readPage('damping');

  const foreign = await harness('route-wiki-foreign', { store: mine.store, studentId: 'student-b' });
  // A foreign workspace shares the vault root only because the test hands it over; its
  // sessions live elsewhere, so the save cannot name a turn that is not theirs.
  assert.equal((await post(foreign.wiki, '/wiki/save', { sessionId: 'sess-private', turnIndex: 1 })).status, 404);
  assert.equal((await foreign.wiki.request('/wiki/pages', { headers: AUTH })).status, 200);
  assert.equal((await post(foreign.student, '/brain/pages/damping/restore', { revision: page?.revision, baseRevision: 'rev-stale' })).status, 409);
});
