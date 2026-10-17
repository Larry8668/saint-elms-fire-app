import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CONTRACT_VERSION, SourceRecordSchema, type CompileResult, type EngineSettings, type JobList, type ProposalAcceptance, type SourceDetail, type SourceReceipt } from '@sef/shared';
import type { ContentStore } from '../../content/store';
import type { SettingsReader } from '../../settings/store';
import { SessionStore, type Session } from '../../sessions/store';
import type { WikiStore } from '../../brain/wiki-store';
import { SourceIngestor, type AudioReader } from '../../brain/sources/ingest';
import { YouTubeError, type YouTube } from '../../media/youtube';
import { WikiCompiler } from '../../brain/compiler/compile';
import type { KeeperDraft } from '../../brain/compiler/draft';
import { readProposalRecord } from '../../brain/proposals';
import { PROFILE, T0, tempRoot, vault } from '../../brain/testing/fixtures';
import { decodeSourceBytes, sourceRoutes } from './sources';

test('standard base64 decodes, and padding is not required to match byte-for-byte', () => {
  const body = 'a note body';
  const decoded = decodeSourceBytes(Buffer.from(body, 'utf8').toString('base64'));
  assert.equal(decoded && Buffer.from(decoded).toString('utf8'), body);
  assert.equal(decodeSourceBytes(Buffer.from(body, 'utf8').toString('base64').replace(/=+$/, '')) && 'ok', 'ok');
});

test('the URL-safe alphabet is accepted, not rejected for spelling the same bytes differently', () => {
  // 0xff bytes force the `+` and `/` characters the URL-safe alphabet writes as `-`/`_`.
  const raw = Buffer.from([0xff, 0xff, 0xff, 0x41, 0xfb, 0xef]);
  const standard = raw.toString('base64');
  assert.match(standard, /[+/]/, 'the fixture must actually exercise both alphabets');
  const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
  assert.deepEqual(decodeSourceBytes(urlSafe), new Uint8Array(raw));
});

test('whitespace a transport folded in is tolerated', () => {
  const standard = Buffer.from('wrapped', 'utf8').toString('base64');
  const decoded = decodeSourceBytes(`${standard.slice(0, 4)}\n  ${standard.slice(4)}`);
  assert.equal(decoded && Buffer.from(decoded).toString('utf8'), 'wrapped');
});

test('input that is not base64 at all is refused, not silently zero-filled', () => {
  assert.equal(decodeSourceBytes('!!! not base64 !!!'), null);
  assert.equal(decodeSourceBytes('@@@@'), null);
});

/**
 * Route-level coverage over a real vault: the workspace stub is the same shape the
 * profile manager hands out, so the ownership guard and the honest {error} answers are
 * exercised, not assumed.
 */
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

const draft = (over: Partial<KeeperDraft> = {}): KeeperDraft => ({ pages: [], links: [], ...over });
const pageDraft = (over: Partial<KeeperDraft['pages'][number]> = {}): KeeperDraft['pages'][number] => ({
  title: 'Momentum',
  kind: 'concept',
  summary: 'What momentum says now.',
  markdown: '# Momentum\n\nForce changes momentum.',
  claims: [],
  ...over,
});

const AUTH = { authorization: 'Bearer valid', 'content-type': 'application/json' };

interface RouteHarness {
  app: ReturnType<typeof sourceRoutes>;
  store: WikiStore;
  sources: SourceIngestor;
  compiler: WikiCompiler;
  sessions: SessionStore;
}

async function routeHarness(prefix: string, opts: { store?: WikiStore; studentId?: string; audio?: AudioReader; youtube?: Partial<YouTube>; propose?: (prompt: string) => Promise<KeeperDraft> } = {}): Promise<RouteHarness> {
  const store = opts.store ?? (await vault(prefix));
  const identity = { ...PROFILE, studentId: opts.studentId ?? PROFILE.studentId };
  const sources = new SourceIngestor(store, async () => identity, opts.audio);
  const compiler = new WikiCompiler(store, { settings, content, profile: async () => identity, propose: opts.propose });
  const sessions = new SessionStore(await tempRoot(`${prefix}-sessions`));
  const profile = { id: identity.studentId, name: 'Student', email: 's@example.test', cohortId: 'cohort-a' };
  const brain = { pageDiffs: async () => [], readImageSource: async () => null };
  const ws = { profile, sources, compiler, wiki: store, brain, sessions, youtube: opts.youtube };
  const app = sourceRoutes({
    settings: {},
    auth: { resolve: async (token: string) => (token === 'valid' ? { profile, mode: 'offline' as const } : null) },
    workspaces: { get: async () => ws },
  } as never);
  return { app, store, sources, compiler, sessions };
}

const post = (app: RouteHarness['app'], path: string, body?: unknown) => app.request(path, { method: 'POST', headers: AUTH, body: body === undefined ? undefined : JSON.stringify(body) });

test('a source is filed, read back in detail, corrected and previewed — all over HTTP', async () => {
  const { app, store } = await routeHarness('route-flow', {
    propose: async () => draft({ pages: [pageDraft({ claims: [{ text: 'Force changes momentum', kind: 'source_fact', quote: 'Force changes momentum over time.' }] })] }),
  });

  const filed = await post(app, '/sources', {
    kind: 'note',
    title: 'Lecture notes',
    mediaType: 'text/markdown',
    data: Buffer.from('Force changes momentum over time.', 'utf8').toString('base64'),
    origin: 'student',
  });
  assert.equal(filed.status, 201);
  const receipt = (await filed.json()) as SourceReceipt;
  assert.equal(receipt.source.extracted, true);
  const jobId = receipt.jobId;

  const detailRes = await app.request(`/sources/${receipt.source.id}`, { headers: AUTH });
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as SourceDetail;
  assert.match(detail.extraction?.text ?? '', /Force changes momentum/);
  assert.equal(detail.job?.id, jobId);
  assert.equal(detail.job?.stage, 'awaiting_source_review');

  const corrected = await app.request(`/sources/${receipt.source.id}/extraction`, {
    method: 'PUT',
    headers: AUTH,
    body: JSON.stringify({ text: 'Force changes momentum over time. Impulse follows.' }),
  });
  assert.equal(corrected.status, 200);
  assert.equal(((await corrected.json()) as SourceDetail).extraction?.method, 'student_correction');

  // The raw route serves the frozen original, not the correction — and only as a download:
  // a non-image type is never rendered inside the engine origin.
  const raw = await app.request(`/sources/${receipt.source.id}/raw`, { headers: AUTH });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
  assert.match(raw.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await raw.text(), 'Force changes momentum over time.');

  const compiled = await post(app, `/sources/${jobId}/compile`, {});
  assert.equal(compiled.status, 200);
  const result = (await compiled.json()) as CompileResult;
  assert.equal(result.job.stage, 'awaiting_review');
  assert.ok(result.proposalId);

  const preview = await app.request(`/proposals/${result.proposalId}`, { headers: AUTH });
  const body = (await preview.json()) as { pages: Array<{ title: string; addedClaims: unknown[] }> };
  assert.equal(body.pages[0]?.title, 'Momentum');
  assert.equal(body.pages[0]?.addedClaims.length, 1);

  const accepted = await post(app, `/proposals/${result.proposalId}/accept`, {});
  assert.equal(accepted.status, 200);
  const acceptance = (await accepted.json()) as ProposalAcceptance;
  assert.equal(acceptance.record.state, 'accepted');
  assert.equal(acceptance.record.decidedBy, 'student');
  assert.equal(acceptance.report.committed, true);
  assert.equal((await store.readJob(jobId))?.stage, 'committed');
});

test('another profile cannot see, correct or compile the source — 404, not 403', async () => {
  const mine = await routeHarness('route-foreign-a');
  const { source, jobId } = await mine.sources.ingest({
    kind: 'note',
    title: 'Private',
    mediaType: 'text/markdown',
    bytes: Buffer.from('private words', 'utf8'),
  });
  const foreign = await routeHarness('route-foreign-b', { store: mine.store, studentId: 'student-b' });

  assert.equal((await foreign.app.request(`/sources/${source.id}`, { headers: AUTH })).status, 404);
  assert.equal(
    (await foreign.app.request(`/sources/${source.id}/extraction`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ text: 'vandalised' }) })).status,
    404,
  );
  assert.equal((await foreign.app.request(`/sources/${source.id}/raw`, { headers: AUTH })).status, 404);
  assert.equal((await post(foreign.app, `/sources/${jobId}/compile`, {})).status, 404);
  const listed = await foreign.app.request('/sources', { headers: AUTH });
  const board = (await listed.json()) as JobList;
  assert.equal(board.sources.length, 0, 'the foreign catalogue lists nothing');
  assert.equal(board.jobs.length, 0, 'the foreign job board lists nothing');
});

test('accepting a session proposal checkpoints only the frozen turn range', async () => {
  const { app, sources, compiler, sessions } = await routeHarness('route-session', {
    propose: async () => draft({ pages: [pageDraft()] }),
  });
  const session: Session = {
    id: 'sess-checkpoint',
    teacher: 'guide',
    startedAt: T0,
    updatedAt: T0,
    turns: [
      { role: 'user', content: 'What is impulse?', at: T0 },
      { role: 'assistant', content: 'Force over time.', at: T0 },
      { role: 'user', content: 'And after the freeze?', at: T0 },
    ],
    lessonIds: [],
    sources: [],
    ingestedTurns: 0,
  };
  await sessions.put(session);

  const transcript = 'Student: What is impulse?\nTeacher: Force over time.';
  const { jobId } = await sources.ingest({
    kind: 'session',
    title: 'Guide session',
    mediaType: 'text/plain',
    bytes: Buffer.from(transcript, 'utf8'),
    session: { sessionId: session.id, teacher: 'guide', firstTurn: 0, lastTurn: 1 },
    extraction: { method: 'text', text: transcript },
  });
  const compiled = await compiler.compileJob(jobId);
  assert.ok(compiled.proposalId);

  const accepted = await post(app, `/proposals/${compiled.proposalId}/accept`, {});
  assert.equal(accepted.status, 200);
  const after = await sessions.get(session.id);
  assert.equal(after?.ingestedTurns, 2, 'only turns 0–1 checkpoint; turn 2 arrived after the freeze');
});

test('a pageIds selection writes only those pages; the original closes as applied-in-part', async () => {
  const { app, sources, compiler, store } = await routeHarness('route-partial', {
    propose: async () => draft({ pages: [pageDraft({}), pageDraft({ title: 'Energy', summary: 'Energy in the system.', markdown: '# Energy', claims: [] })] }),
  });
  const { jobId } = await sources.ingest({
    kind: 'note',
    title: 'Mechanics notes',
    mediaType: 'text/markdown',
    bytes: Buffer.from('Momentum and energy notes.', 'utf8'),
  });
  const compiled = await compiler.compileJob(jobId);
  const original = await readProposalRecord(store.root, compiled.proposalId!);
  const ids = original!.proposal.operations.flatMap((op) => (op.op === 'upsert_page' ? [op.page.id] : []));

  const accepted = await post(app, `/proposals/${compiled.proposalId}/accept`, { pageIds: [ids[0]] });
  assert.equal(accepted.status, 200);
  const acceptance = (await accepted.json()) as ProposalAcceptance;
  assert.deepEqual(acceptance.report.pages.map((page) => page.id), [ids[0]]);
  assert.equal((await store.readPage(ids[1]!)) === null, true);

  const decided = await readProposalRecord(store.root, compiled.proposalId!);
  assert.equal(decided?.state, 'rejected');
  assert.match(decided?.note ?? '', /applied in part/i);
});

test('job and proposal state errors surface as honest 409s, never silent no-ops', async () => {
  const { app, sources, compiler } = await routeHarness('route-state', {
    propose: async () => draft({ pages: [pageDraft()] }),
  });
  const { jobId } = await sources.ingest({ kind: 'note', title: 'Notes', mediaType: 'text/markdown', bytes: Buffer.from('text', 'utf8') });
  const compiled = await compiler.compileJob(jobId);

  assert.equal((await post(app, `/sources/${jobId}/compile`, {})).status, 409, 'a job awaiting review cannot compile again');
  assert.equal((await post(app, `/sources/${jobId}/retry`, {})).status, 409, 'only a failed job retries');
  assert.equal((await post(app, '/proposals/prop_missing/accept', {})).status, 404);

  const rejected = await post(app, `/proposals/${compiled.proposalId}/reject`, { note: 'not this one' });
  assert.equal(rejected.status, 200);
  assert.equal((await post(app, `/proposals/${compiled.proposalId}/accept`, {})).status, 409, 'a decided proposal cannot be decided again');
});

test('a malformed envelope answers 400 with a code, never a crash', async () => {
  const { app } = await routeHarness('route-invalid');
  assert.equal((await post(app, '/sources', { kind: 'note', title: 'x', mediaType: 'text/plain', data: '%%%' })).status, 400);
  assert.equal((await post(app, '/sources', { kind: 'session', title: 'x', mediaType: 'text/plain', data: 'eA==' })).status, 400, 'sessions cannot be smuggled over the contribute route');
  assert.equal((await post(app, '/sources', { kind: 'note', title: 'x', mediaType: 'text/plain', data: 'eA==', sneaky: true })).status, 400);
});

test('a media type outside the allowlist is a typed 415, not a stored source', async () => {
  const { app, store } = await routeHarness('route-media');
  const refused = await post(app, '/sources', {
    kind: 'document',
    title: 'Page',
    mediaType: 'text/html',
    data: Buffer.from('<html><script>alert(1)</script></html>', 'utf8').toString('base64'),
  });
  assert.equal(refused.status, 415);
  const body = (await refused.json()) as { error: string; code: string };
  assert.equal(body.code, 'unsupported_media');
  assert.deepEqual(Object.keys(await store.listSources()), [], 'nothing was kept');
});

test('only PNG and JPEG render inline; a planted text/html record downloads as opaque bytes', async () => {
  const store = await vault('route-raw-vault');
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const planted = (id: string, mediaType: string, bytes: Buffer, kind: 'document' | 'image' = 'document') =>
    SourceRecordSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      id,
      profile: PROFILE,
      revision: 'rev-1',
      kind,
      origin: 'external',
      title: id,
      createdAt: T0,
      mediaType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      attribution: {},
      extractions: [],
    });
  // A record an older or tampered vault could still hold: ingest refuses this type today,
  // but the raw route must stay safe against what is already on disk.
  await store.putSource(planted('planted-html', 'text/html', Buffer.from('<script>alert(1)</script>', 'utf8')), Buffer.from('<script>alert(1)</script>', 'utf8'));
  await store.putSource(planted('photo-1', 'image/png', pngBytes, 'image'), pngBytes);
  const { app } = await routeHarness('route-raw', { store });

  const html = await app.request('/sources/planted-html/raw', { headers: AUTH });
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('content-type'), 'application/octet-stream', 'the planted type never reaches the browser');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff', 'and cannot be sniffed back');
  assert.match(html.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(await html.text(), '<script>alert(1)</script>', 'the bytes themselves are still served');

  const png = await app.request('/sources/photo-1/raw', { headers: AUTH });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png', 'the preview types still render');
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(png.headers.get('content-disposition'), null);
});

test('a video link previews metadata-only, then the consented fetch files a video source', async () => {
  const link = { provider: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abc123XYZ_0', videoId: 'abc123XYZ_0', fetchedAt: new Date().toISOString() };
  const calls: string[] = [];
  const youtube: Partial<YouTube> = {
    preview: async (url: string) => {
      calls.push(`preview:${url}`);
      return { provider: 'youtube', url: link.url, videoId: link.videoId, title: 'Orbits, explained', seconds: 95, uploader: 'Example Lectures' };
    },
    fetchAudio: async (url: string) => {
      calls.push(`fetch:${url}`);
      return { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), mediaType: 'audio/wav', title: 'Orbits, explained', uploader: 'Example Lectures', seconds: 95, link };
    },
  };
  const { app } = await routeHarness('route-video', {
    youtube,
    audio: {
      probe: async () => ({ seconds: 95 }),
      transcribe: async () => ({ text: '[0:00] Kepler saw the ellipse.', seconds: 95, chunks: 2, attemptedChunks: 2, failedChunks: 0, partial: false }),
    },
  });

  // The preview carries the card fields and no bytes.
  const previewRes = await app.request('/sources/video-preview', { method: 'POST', headers: AUTH, body: JSON.stringify({ url: 'https://youtu.be/abc123XYZ_0' }) });
  assert.equal(previewRes.status, 200);
  const preview = (await previewRes.json()) as { title: string; videoId: string; seconds: number };
  assert.equal(preview.title, 'Orbits, explained');
  assert.equal(preview.videoId, 'abc123XYZ_0');

  const fetchRes = await app.request('/sources/video', { method: 'POST', headers: AUTH, body: JSON.stringify({ url: link.url }) });
  assert.equal(fetchRes.status, 201);
  const receipt = (await fetchRes.json()) as SourceReceipt;
  assert.equal(receipt.source.kind, 'video');
  assert.equal(receipt.extraction?.method, 'audio', 'the fetched track reads through the audio pipeline');
  assert.match(receipt.extraction?.text ?? '', /Kepler/);
  assert.deepEqual(calls, ['preview:https://youtu.be/abc123XYZ_0', `fetch:${link.url}`], 'preview and fetch are the two distinct, consented calls');
});

test('video failures map to their named codes over HTTP', async () => {
  const youtube: Partial<YouTube> = {
    preview: async () => {
      throw new YouTubeError('Only YouTube links can be fetched.', 'unsupported_host');
    },
    fetchAudio: async () => {
      throw new YouTubeError('yt-dlp is not installed.', 'ytdlp_missing');
    },
  };
  const { app } = await routeHarness('route-video-errors', { youtube });
  const previewRes = await app.request('/sources/video-preview', { method: 'POST', headers: AUTH, body: JSON.stringify({ url: 'https://vimeo.com/1' }) });
  assert.equal(previewRes.status, 400);
  assert.equal(((await previewRes.json()) as { code: string }).code, 'unsupported_host');
  const fetchRes = await app.request('/sources/video', { method: 'POST', headers: AUTH, body: JSON.stringify({ url: 'https://youtu.be/abc123XYZ_0' }) });
  assert.equal(fetchRes.status, 503);
  assert.equal(((await fetchRes.json()) as { code: string }).code, 'ytdlp_missing');
});
