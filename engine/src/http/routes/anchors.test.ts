import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION } from '@sef/shared';
import type { AnchorCatalog, AnchorMatchResult, EngineSettings, WebPreview } from '@sef/shared';
import type { ContentStore } from '../../content/store';
import type { SettingsReader } from '../../settings/store';
import { SessionStore, type Session } from '../../sessions/store';
import { BrainService } from '../../brain/service';
import { SourceIngestor } from '../../brain/sources/ingest';
import { BrainVault } from '../../brain/vault';
import { conceptDraft, PROFILE, proposal, T0, tempRoot, vault } from '../../brain/testing/fixtures';
import type { WikiStore } from '../../brain/wiki-store';
import { anchorRoutes } from './anchors';
import { studentRoutes } from './student';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-anchor-routes-'));

/** One released course, so the graph names exactly what this programme teaches. */
const LESSONS = [
  {
    id: 'lesson-momentum',
    courseId: 'classical-mechanics',
    courseName: 'Classical Mechanics',
    moduleId: 'm1',
    moduleName: 'Mechanics I',
    subjectId: 'physics',
    semesterNumber: 1,
    order: 1,
    title: 'Momentum and Its Conservation',
    concepts: ['momentum', 'damping', 'impulse', 'force balance', 'force diagrams'],
    prerequisites: [],
    tags: [],
    markdown: 'Momentum is conserved in isolated systems.',
  },
];

const settings: SettingsReader = {
  get: async () =>
    ({
      uniServerUrl: 'https://uni.example.test',
      // Nothing is listening here: the preview must say unreachable, not fail.
      searxngUrl: 'http://127.0.0.1:9',
      thinking: false,
      providers: [{ id: 'p', kind: 'ollama', label: 'Test model', baseUrl: 'http://127.0.0.1:9' }],
      roles: { tutor: { provider: 'p', model: 'm' }, brain: { provider: 'p', model: 'm' }, vision: { provider: 'p', model: 'm' } },
    }) as EngineSettings,
};
const content = { academicLessons: async () => LESSONS, supportLessons: async () => [], allLessons: async () => LESSONS, installed: async () => ({}), lesson: async (id: string) => LESSONS.find((l) => l.id === id) ?? null } as unknown as ContentStore;
const AUTH = { authorization: 'Bearer valid', 'content-type': 'application/json' };

/** The real stores over the real vault, behind the real route modules — only auth is stubbed. */
async function harness(prefix: string, opts: { store?: WikiStore; studentId?: string } = {}) {
  const identity = { ...PROFILE, studentId: opts.studentId ?? PROFILE.studentId };
  const store = opts.store ?? (await vault(prefix));
  const sources = new SourceIngestor(store, async () => identity);
  const sessions = new SessionStore(await tempRoot(`${prefix}-sessions`));
  const vaultView = new BrainVault(store.root);
  await vaultView.init();
  const brain = new BrainService(content, vaultView, settings, await tempRoot(`${prefix}-quizzes`), { wiki: store, sources, identity: async () => identity });
  const profile = { id: identity.studentId, name: 'Student', email: 's@example.test', cohortId: 'cohort-a', programmeId: PROFILE.programmeId };
  const ws = { profile, sources, wiki: store, vault: vaultView, brain, sessions, settings, content };
  const deps = {
    settings: {},
    auth: { resolve: async (token: string) => (token === 'valid' ? { profile, mode: 'offline' as const } : null) },
    workspaces: { get: async () => ws },
  } as never;
  return { store, sessions, ws, anchors: anchorRoutes(deps), student: studentRoutes(deps) };
}

const openSession = async (app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response }) => {
  const res = await app.request('/chat/sessions', { method: 'POST', headers: AUTH, body: JSON.stringify({ teacher: 'philosopher' }) });
  assert.equal(res.status, 200);
  return ((await res.json()) as { sessionId: string }).sessionId;
};

const turn = (
  app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response },
  sessionId: string,
  body: Record<string, unknown>,
) =>
  app.request('/chat/turn', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ schemaVersion: CONTRACT_VERSION, sessionId, teacher: 'philosopher', clientMessageId: `msg-${Math.random().toString(36).slice(2, 10)}`, message: 'Where does this idea lead?', ...body }),
  });

test('the catalogue serves only this student’s committed, course-linked pages', async () => {
  const { store, anchors } = await harness('anchors-http-catalogue');
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('damping') },
        { op: 'upsert_page', page: conceptDraft('private-idea', { courseRefs: [] }) },
      ],
      { damping: null, 'private-idea': null },
    ),
  );

  const res = await anchors.request('/anchors', { headers: AUTH });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AnchorCatalog;
  assert.deepEqual(body.anchors.map((a) => a.pageId), ['damping'], 'the unlinked page never leaves the catalogue');
  assert.match(body.anchors[0]!.pageRevision, /^rev-/);

  assert.equal((await anchors.request('/anchors', { headers: { 'content-type': 'application/json' } })).status, 401, 'unauthenticated is refused');
});

test('match resolves one page, returns ambiguity for the student to choose, and needs a query', async () => {
  const { store, anchors } = await harness('anchors-http-match');
  await store.applyProposal(
    proposal(
      [
        { op: 'upsert_page', page: conceptDraft('force-balance') },
        // conceptKey strips the plural: the course concept is 'force-diagram'.
        { op: 'upsert_page', page: conceptDraft('force-diagram') },
      ],
      { 'force-balance': null, 'force-diagram': null },
    ),
  );

  const ambiguous = await anchors.request('/anchors/match?q=force', { headers: AUTH });
  const match = (await ambiguous.json()) as AnchorMatchResult;
  assert.equal(match.outcome, 'ambiguous');
  assert.deepEqual(match.anchors.map((a) => a.pageId).sort(), ['force-balance', 'force-diagram']);

  const resolved = await anchors.request('/anchors/match?q=damping', { headers: AUTH });
  assert.equal(((await resolved.json()) as AnchorMatchResult).outcome, 'none', 'no page → none, not a guess');

  const one = await anchors.request('/anchors/match?q=force%20balance', { headers: AUTH });
  assert.equal(((await one.json()) as AnchorMatchResult).outcome, 'resolved');
  assert.equal((await anchors.request('/anchors/match', { headers: AUTH })).status, 400, 'an empty query is a bad request');
});

test('the web preview names the topic-only query and an unreachable engine honestly', async () => {
  const { store, anchors } = await harness('anchors-http-preview');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));

  const res = await anchors.request('/anchors/damping/web-preview', { headers: AUTH });
  assert.equal(res.status, 200);
  const preview = (await res.json()) as WebPreview;
  assert.equal(preview.query, 'damping', 'the released course’s label — never the student’s words');
  assert.equal(preview.engine, 'searxng');
  assert.equal(preview.reachable, false, 'nothing listens on the test port');

  const missing = await anchors.request('/anchors/ghost/web-preview', { headers: AUTH });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { code: string }).code, 'uncommitted_page');

  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('private-idea', { courseRefs: [] }) }], { 'private-idea': null }));
  const unlinked = await anchors.request('/anchors/private-idea/web-preview', { headers: AUTH });
  assert.equal(unlinked.status, 409);
  assert.equal(((await unlinked.json()) as { code: string }).code, 'not_a_course_concept');
});

test('an ambiguous anchorQuery is a 409 with candidates — the engine never guesses', async () => {
  const { store, student } = await harness('anchors-http-ambiguous');
  await store.applyProposal(
    proposal(
      [{ op: 'upsert_page', page: conceptDraft('force-balance') }, { op: 'upsert_page', page: conceptDraft('force-diagram') }],
      { 'force-balance': null, 'force-diagram': null },
    ),
  );
  const sessionId = await openSession(student);

  const res = await turn(student, sessionId, { anchorQuery: 'force' });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code: string; anchors: Array<{ pageId: string }> };
  assert.equal(body.code, 'anchor_ambiguous');
  assert.deepEqual(body.anchors.map((a) => a.pageId).sort(), ['force-balance', 'force-diagram']);
});

test('a resolved anchorQuery passes the seam; a stale claim and an unknown page refuse by name', async () => {
  const { store, student } = await harness('anchors-http-turn');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const sessionId = await openSession(student);

  // Resolved: the seam lets the turn through — with no model running it ends in an error
  // event, but crucially not in the anchor refusal text a failed seam would serve.
  const resolved = await turn(student, sessionId, { anchorQuery: 'damping' });
  assert.equal(resolved.status, 200);
  const resolvedBody = await resolved.text();
  assert.doesNotMatch(resolvedBody, /No exploration anchor|not committed to your wiki|changed since it was chosen/, 'the resolved query passed the anchor seam');

  const stale = await turn(student, sessionId, { anchorPageId: 'damping', anchorRevision: 'rev-superseded' });
  assert.equal(stale.status, 200);
  assert.match(await stale.text(), /stale_revision/, 'the claimed revision no longer matches the page on disk');

  const ghost = await turn(student, sessionId, { anchorPageId: 'ghost' });
  assert.equal(ghost.status, 200);
  assert.match(await ghost.text(), /uncommitted_page/);
});

test('a later turn with no selector continues the anchor the session was served under', async () => {
  const { store, sessions, student } = await harness('anchors-http-continuation');
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const snapshot = await store.readPage('damping');
  const sessionId = await openSession(student);

  // The anchor a previous turn was served under is the server's own record.
  const session: Session = {
    id: sessionId,
    teacher: 'philosopher',
    startedAt: T0,
    updatedAt: T0,
    turns: [],
    lessonIds: [],
    sources: [],
    ingestedTurns: 0,
    anchor: {
      pageId: 'damping',
      pageRevision: snapshot?.revision ?? 'rev-x',
      courseConceptKey: 'damping',
      courseRefs: ['classical-mechanics'],
      title: 'Concept damping',
      summary: 'What damping says in one line.',
      status: 'met',
      courseName: 'Classical Mechanics',
      conceptLabel: 'damping',
      updatedAt: T0,
    },
  };
  await sessions.put(session);

  const res = await turn(student, sessionId, {});
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /no_anchor|No exploration anchor/, 'the stored anchor carried the turn through the seam');
});
