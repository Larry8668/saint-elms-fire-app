import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, type EngineSettings, type PublishedShare, type SharePayload, type ShareScreening } from '@sef/shared';
import { WikiCompiler } from '../brain/compiler/compile';
import type { KeeperDraft } from '../brain/compiler/draft';
import { SourceIngestor } from '../brain/sources/ingest';
import { clock, conceptDraft, legacyPage, PROFILE, proposal, tempRoot, vault, writeLegacyVault } from '../brain/testing/fixtures';
import { WikiStore } from '../brain/wiki-store';
import type { ContentStore } from '../content/store';
import type { SettingsReader } from '../settings/store';
import { PeerShareError, PeerShareService, type ShareCall } from './service';
import { PeerShareStore } from './store';

/** Same deterministic settings/content stubs the compiler pipeline tests use. */
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
const content = { academicLessons: async () => [] } as unknown as ContentStore;
const identity = async () => PROFILE;

const keeperDraft = (pages?: KeeperDraft['pages']): KeeperDraft => ({
  pages: pages ?? [
    {
      title: 'Damping',
      kind: 'concept',
      summary: 'What damping says now.',
      markdown: '# Damping\n\nThe envelope falls exponentially.',
      claims: [{ text: 'The envelope falls exponentially', kind: 'source_fact', quote: 'The envelope falls exponentially.' }],
    },
  ],
  links: [],
});

const share = (over: Partial<PublishedShare> = {}): PublishedShare => ({
  schemaVersion: CONTRACT_VERSION,
  id: 'share-1',
  revision: 'rev-1',
  senderId: 'student-b',
  senderName: 'Bea',
  programmeId: 'bsc-physics',
  cohortId: 'coh-1',
  createdAt: '2026-10-15T10:00:00.000Z',
  state: 'published',
  payload: {
    title: 'Damping notes',
    markdown: 'The envelope falls exponentially.',
    citations: [],
    attachments: [],
  },
  ...over,
});

/** The network is a scripted seam: a path → response map, or a thrown PeerShareError. */
type Responder = (path: string, init: { method?: 'GET' | 'POST'; body?: unknown; token: string }) => { status: number; data: unknown };

interface Harness {
  service: PeerShareService;
  store: WikiStore;
  shareStore: PeerShareStore;
  calls: Array<{ path: string; init: { method?: 'GET' | 'POST'; body?: unknown; token: string } }>;
}

async function harness(
  prefix: string,
  opts: {
    respond?: Responder;
    token?: string | undefined;
    cohortId?: string | null;
    propose?: (prompt: string) => Promise<KeeperDraft>;
    store?: WikiStore;
    screen?: (payload: SharePayload) => Promise<ShareScreening>;
  } = {},
): Promise<Harness> {
  const store = opts.store ?? (await vault(prefix));
  const sources = new SourceIngestor(store, identity);
  const compiler = new WikiCompiler(store, { settings, content, profile: identity, propose: opts.propose ?? (async () => keeperDraft()) });
  const shareStore = new PeerShareStore(path.join(await tempRoot(`${prefix}-ledger`), 'shares.json'));
  const calls: Harness['calls'] = [];
  const call: ShareCall = async (_base, callPath, init) => {
    calls.push({ path: callPath, init });
    if (!opts.respond) throw new Error(`Unexpected network call ${callPath}`);
    return opts.respond(callPath, init);
  };
  const service = new PeerShareService({
    wiki: store,
    sources,
    compiler,
    store: shareStore,
    uniUrl: async () => 'https://uni.example.test',
    uniToken: async () => ('token' in opts ? opts.token : 'uni-session-token'),
    enrolment: async () => ({ programmeId: PROFILE.programmeId, cohortId: 'cohortId' in opts ? (opts.cohortId ?? null) : 'coh-1' }),
    call,
    ...(opts.screen ? { screen: { screen: opts.screen } } : {}),
  });
  return { service, store, shareStore, calls };
}

const unreachable: Responder = () => {
  throw new PeerShareError('unreachable', 'The university server cannot be reached right now.');
};

const seedOwn = async (shareStore: PeerShareStore, over: Partial<PublishedShare> = {}) => {
  const mine = share({ id: 'mine-1', senderId: 'student-a', senderName: 'Me', ...over });
  await shareStore.recordPublished(mine);
  return mine;
};

test('the feed forwards the cursor verbatim and annotates mine/ignored/imported items', async () => {
  const mine = share({ id: 'mine-1', senderId: 'student-a', senderName: 'Me' });
  const peers = share({ id: 'share-1' });
  const hidden = share({ id: 'share-2', payload: { title: 'Hidden', markdown: 'No thanks.', citations: [], attachments: [] } });
  const withdrawn = share({ id: 'share-3', state: 'withdrawn' });
  const { service, shareStore, calls } = await harness('feed-annotate', {
    respond: (path) => {
      assert.match(path, /^\/v1\/shares\?/);
      return { status: 200, data: { schemaVersion: CONTRACT_VERSION, items: [peers, mine, hidden, withdrawn], nextCursor: 'cursor-2' } };
    },
  });
  await shareStore.recordPublished(mine);
  await shareStore.setIgnored('share-2', true);

  const feed = await service.feed({ cursor: 'abc', limit: 10 });
  assert.equal(feed.state, 'ok');
  assert.equal(feed.nextCursor, 'cursor-2');
  assert.equal(feed.cohortId, 'coh-1');
  assert.match(calls[0]!.path, /cursor=abc/);
  assert.match(calls[0]!.path, /limit=10/);
  assert.equal(calls[0]!.init.token, 'uni-session-token');

  assert.equal(feed.items.length, 3, 'a withdrawn item never reaches the feed');
  const [peerItem, mineItem, hiddenItem] = feed.items;
  assert.equal(peerItem?.id, 'share-1');
  assert.equal(peerItem?.mine, false);
  assert.equal(peerItem?.ignored, false);
  assert.equal(peerItem?.import, null);
  assert.equal(mineItem?.mine, true);
  assert.equal(hiddenItem?.ignored, true);
});

test('the feed is an honest empty state, never fabricated', async () => {
  const offline = await harness('feed-offline', { respond: unreachable });
  const down = await offline.service.feed();
  assert.equal(down.state, 'offline');
  assert.equal(down.items.length, 0);
  assert.equal(down.nextCursor, null);

  const refused = await harness('feed-refused', {
    respond: () => {
      throw new PeerShareError('unapproved', 'Your enrolment is not approved.', 403);
    },
  });
  assert.equal((await refused.service.feed()).state, 'unavailable');

  const noSession = await harness('feed-nosession', { token: undefined });
  const unsigned = await noSession.service.feed();
  assert.equal(unsigned.state, 'auth_required');
  assert.equal(unsigned.items.length, 0);
  assert.match(unsigned.detail ?? '', /sign in/i);
  assert.equal(noSession.calls.length, 0, 'no token means no request was ever attempted');
});

test('prepare builds the exact request, discloses the cohort and lists the exclusions', async () => {
  const { service, store } = await harness('prepare', { cohortId: 'coh-1' });
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));

  const draft = await service.prepare({ pageId: 'damping' });
  assert.equal(draft.cohortId, 'coh-1');
  assert.equal(draft.request.programmeId, PROFILE.programmeId);
  assert.equal(draft.request.payload.title, 'Concept damping');
  assert.ok(draft.excluded.length > 0, 'the preview tells the student what was left out');
  assert.match(draft.request.idempotencyKey, /^pub_damping_/);
});

test('prepare refuses a page that is not in the vault', async () => {
  const { service } = await harness('prepare-missing');
  await assert.rejects(() => service.prepare({ pageId: 'nope' }), PeerShareError);
});

test('a legacy concept page shares through the same deterministic builder', async () => {
  const root = await tempRoot('prepare-legacy');
  await writeLegacyVault(root, { pages: [legacyPage('momentum')] });
  const store = new WikiStore(root, { now: clock(), lockTimeoutMs: 1_000 });
  await store.init();
  const { service } = await harness('prepare-legacy-svc', { store });

  const draft = await service.prepare({ pageId: 'momentum' });
  assert.equal(draft.request.payload.title, 'Concept momentum');
  // The serialized "Where I got stuck" section is on the private denylist.
  assert.ok(!draft.request.payload.markdown.includes('Why amplitude decays exponentially.'), 'the stuck section stays home');
});

test('publish relays the previewed request verbatim, records it and reports replays', async () => {
  const mine = share({ id: 'published-1', senderId: 'student-a', senderName: 'Me' });
  const { service, store, shareStore, calls } = await harness('publish', {
    respond: (path, init) => {
      assert.equal(path, '/v1/shares');
      assert.equal(init.method, 'POST');
      return { status: 201, data: mine };
    },
  });
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }], { damping: null }));
  const draft = await service.prepare({ pageId: 'damping' });

  const result = await service.publish(draft.request);
  assert.equal(result.replayed, false);
  assert.deepEqual(calls[0]!.init.body, draft.request, 'the wire body is the previewed request');
  assert.equal((await shareStore.read()).published['published-1']?.id, 'published-1');
});

test('a replayed publish (status 200) is reported, not duplicated', async () => {
  const mine = share({ id: 'published-2', senderId: 'student-a', senderName: 'Me' });
  const { service } = await harness('publish-replay', { respond: () => ({ status: 200, data: mine }) });
  const result = await service.publish({
    schemaVersion: CONTRACT_VERSION,
    programmeId: PROFILE.programmeId,
    idempotencyKey: 'pub_damping_same',
    payload: { title: 'Damping', markdown: 'Same body.', citations: [], attachments: [] },
  });
  assert.equal(result.replayed, true);
});

test('publish refuses a draft stamped for another programme', async () => {
  const { service, calls } = await harness('publish-mismatch');
  await assert.rejects(
    () =>
      service.publish({
        schemaVersion: CONTRACT_VERSION,
        programmeId: 'bsc-chemistry',
        idempotencyKey: 'pub_x_1',
        payload: { title: 'X', markdown: 'Y', citations: [], attachments: [] },
      }),
    /different programme/,
  );
  assert.equal(calls.length, 0, 'a mismatched draft never reaches the network');
});

test('mine returns author items — withdrawn ones too — and survives the uni being down', async () => {
  const { service, shareStore } = await harness('mine-offline', { respond: unreachable });
  const live = await seedOwn(shareStore, { id: 'mine-live' });
  const gone = await seedOwn(shareStore, { id: 'mine-gone', state: 'withdrawn' });

  const mine = await service.mine();
  assert.equal(mine.reachable, false);
  assert.equal(mine.items.length, 2);
  assert.ok(mine.items.every((item) => item.freshness === 'stored'), 'offline shows the last confirmed state');
  assert.equal(mine.items.find((i) => i.id === gone.id)?.state, 'withdrawn');
  assert.equal(mine.items.find((i) => i.id === live.id)?.state, 'published');
});

test('mine refreshes a stale stored state when the uni answers', async () => {
  const { service, shareStore } = await harness('mine-live', {
    respond: (path) => {
      assert.equal(path, '/v1/shares/mine-1');
      return { status: 200, data: share({ id: 'mine-1', senderId: 'student-a', senderName: 'Me', state: 'withdrawn', revision: 'rev-2' }) };
    },
  });
  await seedOwn(shareStore, { id: 'mine-1' });
  const mine = await service.mine();
  assert.equal(mine.reachable, true);
  assert.equal(mine.items[0]?.state, 'withdrawn');
  assert.equal(mine.items[0]?.freshness, 'live');
  assert.equal((await shareStore.read()).published['mine-1']?.state, 'withdrawn', 'the ledger follows the confirmed state');
});

test('withdraw posts to the uni and updates the local ledger', async () => {
  const { service, shareStore, calls } = await harness('withdraw', {
    respond: (path, init) => {
      assert.equal(path, '/v1/shares/mine-1/withdraw');
      assert.equal(init.method, 'POST');
      return { status: 200, data: share({ id: 'mine-1', senderId: 'student-a', senderName: 'Me', state: 'withdrawn', revision: 'rev-2' }) };
    },
  });
  await seedOwn(shareStore, { id: 'mine-1' });
  const result = await service.withdraw('mine-1');
  assert.equal(result.state, 'withdrawn');
  assert.equal((await shareStore.read()).published['mine-1']?.state, 'withdrawn');
  assert.equal(calls.length, 1);
});

test('import freezes the share as a peer source and files a proposal — the brain waits for review', async () => {
  const incoming = share({ id: 'share-9' });
  const { service, store } = await harness('import', {
    respond: (path) => {
      assert.equal(path, '/v1/shares/share-9');
      return { status: 200, data: incoming };
    },
  });

  const result = await service.importShare('share-9');
  assert.equal(result.reused, false);
  assert.equal(result.stage, 'awaiting_review');
  assert.ok(result.proposalId, 'the compile produced a reviewable proposal');

  const record = await store.readSource(result.sourceId);
  assert.equal(record?.kind, 'peer');
  assert.equal(record?.origin, 'peer');
  assert.equal(record?.share?.id, 'share-9');
  assert.equal(record?.share?.revision, 'rev-1');
  assert.equal(record?.share?.senderId, 'student-b');
  assert.equal(record?.mediaType, 'text/markdown');

  // The vault itself is untouched — the proposal is pending until the student accepts.
  assert.equal((await store.listPages()).length, 0);
});

test('a repeated import of the same share+revision replays — no second source, no second job', async () => {
  const incoming = share({ id: 'share-9' });
  const { service, store } = await harness('import-dedupe', {
    respond: () => ({ status: 200, data: incoming }),
  });
  const first = await service.importShare('share-9');
  const second = await service.importShare('share-9');
  assert.equal(second.reused, true);
  assert.equal(second.sourceId, first.sourceId);
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.proposalId, first.proposalId);
  const peers = Object.values(await store.listSources()).filter((s) => s.kind === 'peer');
  assert.equal(peers.length, 1, 'one frozen source per share+revision');
});

test('a new revision imports as fresh material alongside the old source', async () => {
  let revision = 'rev-1';
  const { service, store } = await harness('import-revision', {
    respond: () => ({ status: 200, data: share({ id: 'share-9', revision }) }),
  });
  const first = await service.importShare('share-9');
  revision = 'rev-2';
  const second = await service.importShare('share-9');
  assert.equal(second.reused, false, 'a newer revision is new material, not a replay');
  assert.notEqual(second.sourceId, first.sourceId);
  const peers = Object.values(await store.listSources()).filter((s) => s.kind === 'peer');
  assert.equal(peers.length, 2, 'each revision freezes its own source');
});

test('a withdrawn share cannot be imported', async () => {
  const { service, store } = await harness('import-withdrawn', {
    respond: () => ({ status: 200, data: share({ id: 'share-9', state: 'withdrawn' }) }),
  });
  await assert.rejects(() => service.importShare('share-9'), /withdrawn/);
  assert.equal(Object.keys(await store.listSources()).length, 0, 'nothing was frozen');
});

test('after import the feed item reports its source+job pair', async () => {
  const incoming = share({ id: 'share-9' });
  const { service } = await harness('import-annotated', {
    respond: (path) => {
      if (path === '/v1/shares/share-9') return { status: 200, data: incoming };
      if (path === '/v1/shares' || path.startsWith('/v1/shares?'))
        return { status: 200, data: { schemaVersion: CONTRACT_VERSION, items: [incoming], nextCursor: null } };
      throw new Error(`Unexpected ${path}`);
    },
  });
  const imported = await service.importShare('share-9');
  const feed = await service.feed();
  const item = feed.items.find((i) => i.id === 'share-9');
  assert.deepEqual(item?.import, { sourceId: imported.sourceId, jobId: imported.jobId });
});

test('an imported share is screened before ingest — the flag rides the result and the source ledger', async () => {
  const incoming = share({ id: 'share-9' });
  const { service, store } = await harness('import-screened', {
    respond: () => ({ status: 200, data: incoming }),
    screen: async () => ({ status: 'flagged', categories: ['harassment'], model: 'shieldgemma:2b' }),
  });
  const result = await service.importShare('share-9');
  assert.equal(result.screening?.status, 'flagged');
  assert.deepEqual(result.screening?.categories, ['harassment']);
  assert.equal(result.reused, false, 'flagged still imports — the screen never blocks');

  const record = await store.readSource(result.sourceId);
  const note = record?.extractions[0]?.note ?? '';
  assert.match(note, /flagged.*harassment/i, 'the extraction ledger carries the advisory for later review');
});

test('with no screener wired the import still lands, honestly marked unavailable', async () => {
  const incoming = share({ id: 'share-9' });
  const { service, store } = await harness('import-unscreened', { respond: () => ({ status: 200, data: incoming }) });
  const result = await service.importShare('share-9');
  assert.equal(result.screening?.status, 'unavailable');
  const record = await store.readSource(result.sourceId);
  assert.match(record?.extractions[0]?.note ?? '', /unavailable/i);
});

test('a replayed import does not screen again — nothing new was fetched', async () => {
  const incoming = share({ id: 'share-9' });
  let screened = 0;
  const { service } = await harness('import-screen-reuse', {
    respond: () => ({ status: 200, data: incoming }),
    screen: async () => {
      screened += 1;
      return { status: 'clean', categories: [], model: 'shieldgemma:2b' };
    },
  });
  const first = await service.importShare('share-9');
  const second = await service.importShare('share-9');
  assert.equal(first.screening?.status, 'clean');
  assert.equal(second.reused, true);
  assert.equal(second.screening, undefined, 'the replay reports what exists, not a fresh screen');
  assert.equal(screened, 1, 'the screener ran once, for the new material only');
});

test('the publish draft carries its own screen — the author sees what importers would', async () => {
  let screenedText = '';
  const { service, store } = await harness('share-screen-draft', {
    screen: async (payload) => {
      screenedText = `${payload.title}\n${payload.markdown}`;
      return { status: 'clean', categories: [], model: 'shieldgemma:2b' };
    },
  });
  await store.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('orbits-intro') }], { 'orbits-intro': null }));
  const draft = await service.prepare({ pageId: 'orbits-intro' });
  assert.equal(draft.screening?.status, 'clean');
  assert.match(screenedText, /orbits/i, 'the screen ran over the draft payload the student is about to publish');
});
