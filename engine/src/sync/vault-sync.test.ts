import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { sourceFixture } from '../brain/testing/fixtures';
import { WikiStore } from '../brain/wiki-store';
import { sha256Hex } from '../lib/hash';
import { blobKey, MemoryObjectStore, syncManifestKey, vaultKey, type ObjectStore, type PutOptions } from '../store';
import { createVaultSync } from './index';
import { installSyncHooks } from './hooks';
import { diffManifest, emptySyncManifest, nextManifest, SyncManifestSchema, TOMBSTONE_TTL_MS, type LocalEntry } from './manifest';
import { syncKind } from './scope';
import { SyncConflictError, VaultSync } from './vault-sync';

const ACCOUNT = 'stu_1';
const roots: string[] = [];
after(async () => {
  installSyncHooks(null);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sef-sync-'));
  roots.push(root);
  return root;
}

async function put(root: string, relPath: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, relPath)), { recursive: true });
  await writeFile(path.join(root, relPath), content);
}

const exists = (file: string) => stat(file).then(() => true, () => false);
const read = (root: string, relPath: string) => readFile(path.join(root, relPath), 'utf8');

/** Counts what reaches the store, so tests can say what was (not) uploaded. */
class CountingStore extends MemoryObjectStore {
  puts: string[] = [];
  gets: string[] = [];
  override async put(key: string, body: Uint8Array | string, options?: PutOptions) {
    this.puts.push(key);
    return super.put(key, body, options);
  }
  override async get(key: string) {
    this.gets.push(key);
    return super.get(key);
  }
}

async function remoteManifest(store: ObjectStore) {
  return SyncManifestSchema.parse(JSON.parse(Buffer.from((await store.get(syncManifestKey(ACCOUNT)))!.body).toString('utf8')));
}

const entry = (sha: string, kind: LocalEntry['kind'] = 'text'): LocalEntry => ({ sha256: sha.repeat(64).slice(0, 64), size: 1, mtime: 1, kind });

test('scope: the vault and resumable stores sync; credentials, counters and in-flight state never do', () => {
  for (const relPath of ['brain/concepts/a.md', 'brain/.meta/manifest.json', 'brain/.history/concepts/a/r1.md', 'sessions/s1.json', 'quizzes/q.json', 'content/installed.json', 'plans/p.json', 'logistics.json', 'feeds.json', 'signals.json', 'shares.json']) {
    assert.equal(syncKind(relPath, 10), 'text', relPath);
  }
  assert.equal(syncKind('brain/raw/src_1/rev-1.png', 10), 'media');
  assert.equal(syncKind('sessions/huge.json', 2 * 1024 * 1024), 'large');
  for (const relPath of ['private-settings.json', 'eval-events.jsonl', 'suggestions-tutor.json', '.vault-sync.json', 'brain/.meta/writer.lock', 'brain/.meta/journal/x.json', 'brain/.meta/embeddings/pages.json', 'brain/concepts/a.md.123.abc.tmp', 'other/x.json']) {
    assert.equal(syncKind(relPath, 10), null, relPath);
  }
});

test('manifest diff: uploads what changed, deletes what vanished, and a lazy stub is not a delete', () => {
  const base = { ...emptySyncManifest(ACCOUNT), files: { 'brain/a.md': { ...entry('a') }, 'brain/b.md': { ...entry('b') }, 'brain/raw/s/r.png': { ...entry('c', 'media') } } };
  const local = new Map([
    ['brain/a.md', entry('a')],
    ['brain/c.md', entry('d')],
  ]);
  const diff = diffManifest(base, local, new Set(['brain/raw/s/r.png']));
  assert.deepEqual(diff, { upload: ['brain/c.md'], deleted: ['brain/b.md'] });
  const next = nextManifest(base, local, new Set(['brain/raw/s/r.png']), diff, new Date('2026-10-17T00:00:00Z'));
  assert.equal(next.version, 1);
  assert.deepEqual(Object.keys(next.files).sort(), ['brain/a.md', 'brain/c.md', 'brain/raw/s/r.png']);
  assert.deepEqual(next.tombstones['brain/b.md'], { deletedAt: '2026-10-17T00:00:00.000Z', sha256: entry('b').sha256 });

  // Writing the path again revives it; an old tombstone ages out.
  const revived = nextManifest(next, new Map([['brain/b.md', entry('e')]]), new Set(), { upload: ['brain/b.md'], deleted: [] }, new Date('2026-10-18T00:00:00Z'));
  assert.equal(revived.tombstones['brain/b.md'], undefined);
  const aged = nextManifest(next, local, new Set(), { upload: [], deleted: [] }, new Date(Date.parse('2026-10-17T00:00:00Z') + TOMBSTONE_TTL_MS + 1));
  assert.deepEqual(aged.tombstones, {});
});

test('roundtrip: restore → edit → push → a fresh machine restores exactly the synced set', async () => {
  const store = new MemoryObjectStore();
  const rootA = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root: rootA });
  const first = await a.restore();
  assert.equal(first.version, 0, 'no manifest: a new account');
  assert.equal(a.state, 'ready');
  await put(rootA, 'brain/concepts/photosynthesis.md', '# Photosynthesis\n');
  await put(rootA, 'sessions/s1.json', '{"turns":[]}');
  await put(rootA, 'private-settings.json', '{"providers":[{"apiKey":"sk-secret"}]}');
  await put(rootA, 'eval-events.jsonl', '{}\n');
  const pushed = await a.push();
  assert.deepEqual([pushed.pushed, pushed.version], [2, 1]);
  assert.equal(await store.get(vaultKey(ACCOUNT, 'private-settings.json')), null, 'credentials never leave the box');

  const rootB = await profileRoot();
  const b = new VaultSync({ store, account: ACCOUNT, root: rootB });
  const restored = await b.restore();
  assert.deepEqual([restored.version, restored.fetched], [1, 2]);
  assert.equal(await read(rootB, 'brain/concepts/photosynthesis.md'), '# Photosynthesis\n');
  assert.equal(await exists(path.join(rootB, 'private-settings.json')), false);
  assert.equal(await exists(path.join(rootB, 'eval-events.jsonl')), false);

  await put(rootB, 'brain/concepts/photosynthesis.md', '# Photosynthesis\n\nLight → sugar.\n');
  assert.equal((await b.push()).pushed, 1, 'only the changed file');
  assert.equal((await b.push()).pushed, 0, 'nothing changed, nothing sent');

  const rootC = await profileRoot();
  await new VaultSync({ store, account: ACCOUNT, root: rootC }).restore();
  assert.equal(await read(rootC, 'brain/concepts/photosynthesis.md'), '# Photosynthesis\n\nLight → sugar.\n');
});

test('a lost compare-and-swap is refused loudly, sets the error state, and stops pushing', async () => {
  const store = new MemoryObjectStore();
  const a = new VaultSync({ store, account: ACCOUNT, root: await profileRoot() });
  const rootB = await profileRoot();
  const b = new VaultSync({ store, account: ACCOUNT, root: rootB });
  await a.restore();
  await b.restore();
  await put(a.root, 'brain/a.md', 'from A');
  await a.push();
  await put(rootB, 'brain/b.md', 'from B');
  await assert.rejects(b.push(), SyncConflictError);
  assert.equal(b.state, 'error');
  assert.equal(b.status().error, 'conflict');
  await assert.rejects(b.push(), SyncConflictError, 'sticky: no retry can clobber the other writer');
  assert.deepEqual(Object.keys((await remoteManifest(store)).files), ['brain/a.md'], 'A’s version stands, nothing merged');

  // The swap itself is conditional too: a writer that slips in after the pre-check still loses.
  const racing = new (class extends MemoryObjectStore {
    override async head(key: string) {
      const info = await super.head(key);
      if (key === syncManifestKey(ACCOUNT) && info) await super.put(key, JSON.stringify({ sneaky: true }));
      return info;
    }
  })();
  const c = new VaultSync({ store: racing, account: ACCOUNT, root: await profileRoot() });
  await c.restore();
  await put(c.root, 'brain/x.md', 'x');
  await c.push();
  await put(c.root, 'brain/y.md', 'y');
  await assert.rejects(c.push(), SyncConflictError);
});

test('deletes travel as tombstones: the remote object goes, and a stale machine drops its copy', async () => {
  const store = new MemoryObjectStore();
  const rootA = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root: rootA });
  await a.restore();
  await put(rootA, 'brain/concepts/old.md', 'old');
  await put(rootA, 'brain/concepts/keep.md', 'keep');
  await a.push();

  // A second engine on another data dir restores v1, then goes quiet.
  await put(rootA, 'brain/concepts/edited.md', 'v1');
  await a.push();
  const rootB = await profileRoot();
  await new VaultSync({ store, account: ACCOUNT, root: rootB }).restore();
  await put(rootB, 'brain/concepts/edited.md', 'v2, edited on B and never pushed');

  await rm(path.join(rootA, 'brain/concepts/old.md'));
  await rm(path.join(rootA, 'brain/concepts/edited.md'));
  const result = await a.push();
  assert.equal(result.deleted, 2);
  const manifest = await remoteManifest(store);
  assert.ok(manifest.tombstones['brain/concepts/old.md']);
  assert.equal(await store.get(vaultKey(ACCOUNT, 'brain/concepts/old.md')), null);

  // B comes back (a restart): the remote moved on, so the tombstone applies.
  const report = await new VaultSync({ store, account: ACCOUNT, root: rootB }).restore();
  assert.equal(report.removed, 1);
  assert.equal(await exists(path.join(rootB, 'brain/concepts/old.md')), false);
  assert.equal(await read(rootB, 'brain/concepts/edited.md'), 'v2, edited on B and never pushed', 'a delete elsewhere never eats an unpushed edit');
  assert.equal(await read(rootB, 'brain/concepts/keep.md'), 'keep');
});

test('an engine restart keeps edits it had not pushed yet', async () => {
  const store = new MemoryObjectStore();
  const root = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root });
  await a.restore();
  await put(root, 'brain/a.md', 'v1');
  await a.push();
  await put(root, 'brain/a.md', 'v2, never pushed');
  const again = new VaultSync({ store, account: ACCOUNT, root });
  assert.equal((await again.restore()).fetched, 0);
  assert.equal(await read(root, 'brain/a.md'), 'v2, never pushed');
  assert.equal((await again.push()).pushed, 1);
});

test('a store that lost a vault this machine synced is an error, not a new account', async () => {
  const store = new MemoryObjectStore();
  const root = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root });
  await a.restore();
  await put(root, 'brain/a.md', 'v1');
  await a.push();
  await store.delete(syncManifestKey(ACCOUNT));
  const again = new VaultSync({ store, account: ACCOUNT, root });
  await assert.rejects(again.restore(), /missing/);
  assert.equal(again.state, 'error');
  assert.equal(again.restored, false);
  await assert.rejects(again.push(), /not restored/);
});

test('a text object newer than the manifest (a push cut off before its swap) rolls forward', async () => {
  const store = new MemoryObjectStore();
  const a = new VaultSync({ store, account: ACCOUNT, root: await profileRoot() });
  await a.restore();
  await put(a.root, 'brain/a.md', 'committed');
  await a.push();
  await store.put(vaultKey(ACCOUNT, 'brain/a.md'), 'uploaded, swap never happened');
  const rootB = await profileRoot();
  const b = new VaultSync({ store, account: ACCOUNT, root: rootB });
  assert.equal((await b.restore()).rolledForward, 1);
  assert.equal(await read(rootB, 'brain/a.md'), 'uploaded, swap never happened');
  assert.equal((await b.push()).pushed, 1, 'the next push commits it');
});

test('media is content-addressed: identical bytes upload once, and a re-push sends nothing', async () => {
  const store = new CountingStore();
  const root = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root });
  await a.restore();
  const image = Buffer.from('\x89PNG same image bytes');
  await put(root, 'brain/raw/src_a/rev-1.png', image);
  await put(root, 'brain/raw/src_b/rev-1.png', image);
  await a.push();
  const blob = blobKey(ACCOUNT, sha256Hex(image));
  assert.equal(store.puts.filter((key) => key === blob).length, 1);
  assert.equal(store.puts.filter((key) => key.includes('/files/brain/raw/')).length, 0, 'media never lands under files/');
  store.puts.length = 0;
  await a.push();
  assert.deepEqual(store.puts, []);
});

test('restored media is a stub fetched on first read, through the wiki store’s own reader', async () => {
  const store = new CountingStore();
  const rootA = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root: rootA });
  await a.restore();
  const wikiA = new WikiStore(path.join(rootA, 'brain'));
  await wikiA.init();
  const { record, bytes } = sourceFixture('src_img', 'pretend this is an image', { mediaType: 'image/png' });
  await wikiA.putSource(record, bytes);
  await a.flush();

  const rootB = await profileRoot();
  const handle = createVaultSync({ account: ACCOUNT, flushToken: null }, store, rootB);
  store.gets.length = 0;
  const report = await handle.sync.restore();
  assert.equal(report.lazy, 1);
  const raw = path.join(rootB, 'brain/raw/src_img/rev-1.png');
  assert.equal(await exists(raw), false, 'not downloaded by the restore');
  assert.equal(store.gets.some((key) => key.includes('/blobs/')), false);

  const wikiB = new WikiStore(path.join(rootB, 'brain'));
  assert.deepEqual(await wikiB.readSourceBytes('src_img'), bytes, 'the first read fetches it');
  assert.equal(await exists(raw), true);
  assert.equal(store.gets.filter((key) => key.includes('/blobs/')).length, 1);
  await wikiB.readSourceBytes('src_img');
  assert.equal(store.gets.filter((key) => key.includes('/blobs/')).length, 1, 'once');

  // A stub is not a delete: pushing from B leaves the blob and its manifest entry alone.
  const rootC = await profileRoot();
  const c = createVaultSync({ account: ACCOUNT, flushToken: null }, store, rootC);
  await c.sync.restore();
  await put(rootC, 'brain/concepts/n.md', 'note');
  await c.sync.push();
  assert.ok((await remoteManifest(store)).files['brain/raw/src_img/rev-1.png']);

  // Erasing the source on C (it never fetched it) removes it everywhere, blob included.
  const wikiC = new WikiStore(path.join(rootC, 'brain'));
  await wikiC.eraseSource('src_img');
  assert.equal(await c.sync.materialize(path.join(rootC, 'brain/raw/src_img/rev-1.png')), false, 'an erased stub is never fetched back');
  await c.sync.push();
  assert.equal((await remoteManifest(store)).files['brain/raw/src_img/rev-1.png'], undefined);
  assert.equal(await store.get(blobKey(ACCOUNT, sha256Hex(bytes))), null);
  installSyncHooks(null);
});

test('embeddings ride along as an optional cache: restored when the model matches, skipped otherwise', async () => {
  const store = new MemoryObjectStore();
  const rootA = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root: rootA, embeddingsEveryMs: Number.MAX_SAFE_INTEGER });
  await a.restore();
  await put(rootA, 'brain/concepts/a.md', 'a');
  await put(rootA, 'brain/.meta/embeddings/pages.json', JSON.stringify({ model: 'embeddinggemma', provider: 'ollama', entries: { a: [0.1, 0.2] } }));
  await a.flush();
  const manifest = await remoteManifest(store);
  assert.deepEqual(manifest.embeddings?.models, ['embeddinggemma']);
  assert.equal(await store.get(vaultKey(ACCOUNT, 'brain/.meta/embeddings/pages.json')), null, 'never a plain synced file');

  const hit = await profileRoot();
  assert.equal((await new VaultSync({ store, account: ACCOUNT, root: hit, embedModel: async () => 'embeddinggemma' }).restore()).embeddings, 'restored');
  assert.match(await read(hit, 'brain/.meta/embeddings/pages.json'), /"a":\[0.1,0.2\]/);

  const miss = await profileRoot();
  assert.equal((await new VaultSync({ store, account: ACCOUNT, root: miss, embedModel: async () => 'another-model' }).restore()).embeddings, 'model_mismatch');
  assert.equal(await exists(path.join(miss, 'brain/.meta/embeddings/pages.json')), false, 'left for the existing code to rebuild');

  // Unchanged vectors are not pushed again.
  await a.flush();
  assert.equal((await remoteManifest(store)).embeddings?.sha256, manifest.embeddings?.sha256);
  assert.equal((await remoteManifest(store)).version, manifest.version);
});

test('vault writes schedule a debounced push through the hooks', async () => {
  const store = new MemoryObjectStore();
  const root = await profileRoot();
  const handle = createVaultSync({ account: ACCOUNT, flushToken: null }, store, root, { scheduler: { debounceMs: 10, maxWaitMs: 50, periodicMs: 60_000 } });
  await handle.sync.start(1);
  const wiki = new WikiStore(path.join(root, 'brain'));
  await wiki.init();
  const { record, bytes } = sourceFixture('src_note', 'a note');
  await wiki.putSource(record, bytes);
  for (let i = 0; i < 50 && (await remoteManifest(store).catch(() => null)) === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const manifest = await remoteManifest(store);
  assert.ok(manifest.files['brain/.meta/sources/src_note.json']);
  handle.sync.stop();
  installSyncHooks(null);
});

test('a lazily fetched blob that does not match its hash is refused, and nothing is written', async () => {
  const store = new MemoryObjectStore();
  const rootA = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root: rootA });
  await a.restore();
  const wikiA = new WikiStore(path.join(rootA, 'brain'));
  await wikiA.init();
  const { record, bytes } = sourceFixture('src_bad', 'image bytes', { mediaType: 'image/png' });
  await wikiA.putSource(record, bytes);
  await a.flush();
  await store.put(blobKey(ACCOUNT, sha256Hex(bytes)), 'tampered');
  const rootB = await profileRoot();
  const b = new VaultSync({ store, account: ACCOUNT, root: rootB });
  await b.restore();
  const raw = path.join(rootB, 'brain/raw/src_bad/rev-1.png');
  await assert.rejects(b.materialize(raw), /does not match its hash/);
  assert.equal(await exists(raw), false);
});

test('a released course file the store lost is skipped with a count; a student page that is missing still fails', async () => {
  const store = new MemoryObjectStore();
  const rootA = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root: rootA });
  await a.restore();
  await put(rootA, 'brain/concepts/photosynthesis.md', '# Photosynthesis\n');
  await put(rootA, 'content/courses/calculus/semester-2/01-lesson.md', '# Lesson\n\npip install numpy\n');
  await a.push();
  // An edge filter refused the lesson's upload (or the store lost it): the object is gone, the manifest still names it.
  await store.delete(vaultKey(ACCOUNT, 'content/courses/calculus/semester-2/01-lesson.md'));

  const rootB = await profileRoot();
  const restored = await new VaultSync({ store, account: ACCOUNT, root: rootB }).restore();
  assert.deepEqual([restored.fetched, restored.missing], [1, 1]);
  assert.equal(await read(rootB, 'brain/concepts/photosynthesis.md'), '# Photosynthesis\n');
  assert.equal(await exists(path.join(rootB, 'content/courses/calculus/semester-2/01-lesson.md')), false);

  await store.delete(vaultKey(ACCOUNT, 'brain/concepts/photosynthesis.md'));
  const c = new VaultSync({ store, account: ACCOUNT, root: await profileRoot() });
  await assert.rejects(c.restore(), /object is missing/);
  assert.equal(c.state, 'error');
});
