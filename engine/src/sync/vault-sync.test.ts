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

test('manifest diff: uploads what changed and deletes what vanished; tombstones revive and age out', () => {
  const base = { ...emptySyncManifest(ACCOUNT), files: { 'brain/a.md': { ...entry('a') }, 'brain/b.md': { ...entry('b') }, 'brain/raw/s/r.png': { ...entry('c', 'media') } } };
  const local = new Map([
    ['brain/a.md', entry('a')],
    ['brain/c.md', entry('d')],
    ['brain/raw/s/r.png', entry('f', 'media')],
  ]);
  const diff = diffManifest(base, local);
  assert.deepEqual(diff, { upload: ['brain/c.md', 'brain/raw/s/r.png'], deleted: ['brain/b.md'] });
  const next = nextManifest(base, local, diff, new Date('2026-10-17T00:00:00Z'));
  assert.equal(next.version, 1);
  assert.deepEqual(Object.keys(next.files).sort(), ['brain/a.md', 'brain/c.md', 'brain/raw/s/r.png']);
  assert.deepEqual(next.tombstones['brain/b.md'], { deletedAt: '2026-10-17T00:00:00.000Z', sha256: entry('b').sha256 });

  // Writing the path again revives it; an old tombstone ages out.
  const revived = nextManifest(next, new Map([['brain/b.md', entry('e')]]), { upload: ['brain/b.md'], deleted: [] }, new Date('2026-10-18T00:00:00Z'));
  assert.equal(revived.tombstones['brain/b.md'], undefined);
  const aged = nextManifest(next, local, { upload: [], deleted: [] }, new Date(Date.parse('2026-10-17T00:00:00Z') + TOMBSTONE_TTL_MS + 1));
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

test('media restores from its blob, verified; an erased source leaves the store too', async () => {
  const store = new MemoryObjectStore();
  const rootA = await profileRoot();
  const a = new VaultSync({ store, account: ACCOUNT, root: rootA });
  await a.restore();
  const wikiA = new WikiStore(path.join(rootA, 'brain'));
  await wikiA.init();
  const { record, bytes } = sourceFixture('src_img', 'pretend this is an image', { mediaType: 'image/png' });
  await wikiA.putSource(record, bytes);
  await a.flush();
  const blob = blobKey(ACCOUNT, sha256Hex(bytes));
  assert.ok(await store.get(blob));

  const rootB = await profileRoot();
  await new VaultSync({ store, account: ACCOUNT, root: rootB }).restore();
  assert.deepEqual(await new WikiStore(path.join(rootB, 'brain')).readSourceBytes('src_img'), bytes);

  await wikiA.eraseSource('src_img');
  await a.push();
  assert.equal((await remoteManifest(store)).files['brain/raw/src_img/rev-1.png'], undefined);
  assert.equal(await store.get(blob), null, 'erasure means erasure');

  // A blob that does not match its hash fails the restore.
  await wikiA.putSource(record, bytes);
  await a.push();
  await store.put(blob, 'tampered');
  await assert.rejects(new VaultSync({ store, account: ACCOUNT, root: await profileRoot() }).restore(), /does not match its hash/);
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
