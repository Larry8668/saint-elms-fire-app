/**
 * Vault sync against a real S3-compatible server: two engines (two data dirs) for one account.
 * Skipped unless OBJECT_STORE_TEST_ENDPOINT is set; see docs/object-store.md. Writes under a
 * random vaults/test-sync-<uuid>/ prefix and deletes it afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { conceptDraft, proposal, sourceFixture } from '../brain/testing/fixtures';
import { WikiStore } from '../brain/wiki-store';
import { S3ObjectStore } from '../store/s3-store';
import { createVaultSync } from './index';
import { installSyncHooks } from './hooks';
import { SyncConflictError } from './vault-sync';

const endpoint = process.env.OBJECT_STORE_TEST_ENDPOINT?.trim();
const skip = endpoint ? false : 'OBJECT_STORE_TEST_ENDPOINT is not set';
const account = `test-sync-${randomUUID()}`;
const store = new S3ObjectStore({
  endpoint: endpoint ?? 'http://127.0.0.1:9',
  region: process.env.OBJECT_STORE_TEST_REGION ?? 'us-east-1',
  bucket: process.env.OBJECT_STORE_TEST_BUCKET ?? 'sef-vaults-test',
  accessKeyId: process.env.OBJECT_STORE_TEST_ACCESS_KEY ?? '',
  secretAccessKey: process.env.OBJECT_STORE_TEST_SECRET_KEY ?? '',
  forcePathStyle: process.env.OBJECT_STORE_TEST_FORCE_PATH_STYLE !== 'false',
});
const roots: string[] = [];
const dataDir = async (name: string) => {
  const root = await mkdtemp(path.join(tmpdir(), `sef-sync-live-${name}-`));
  roots.push(root);
  return root;
};
const exists = (file: string) => stat(file).then(() => true, () => false);

after(async () => {
  installSyncHooks(null);
  if (!skip) {
    let cursor: string | undefined;
    do {
      const page = await store.list(`vaults/${account}/`, { cursor });
      for (const item of page.items) await store.delete(item.key);
      cursor = page.cursor;
    } while (cursor);
  }
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test('live: engine A writes pages and an image and flushes; engine B restores the pages and fetches the image lazily', { skip }, async () => {
  const rootA = await dataDir('a');
  const a = createVaultSync({ account, flushToken: null }, store, rootA);
  await a.sync.restore();
  const wikiA = new WikiStore(path.join(rootA, 'brain'));
  await wikiA.init();
  await wikiA.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('damping') }, { op: 'upsert_page', page: conceptDraft('resonance') }], { damping: null, resonance: null }));
  // A demo-size vault: ~6 MB of pages and history-like text, and a 3 MB image.
  for (let i = 0; i < 400; i += 1) {
    await mkdir(path.join(rootA, 'brain/.history/concepts/bulk'), { recursive: true });
    await writeFile(path.join(rootA, `brain/.history/concepts/bulk/r${i}.md`), `# Revision ${i}\n\n${randomBytes(12 * 1024).toString('base64')}\n`);
  }
  const image = sourceFixture('src_photo', randomBytes(3 * 1024 * 1024).toString('base64'), { mediaType: 'image/png' });
  await wikiA.putSource(image.record, image.bytes);
  let started = Date.now();
  const flushed = await a.sync.flush();
  const pushMs = Date.now() - started;
  assert.ok(flushed.pushed > 400);
  installSyncHooks(null);

  const rootB = await dataDir('b');
  const b = createVaultSync({ account, flushToken: null }, store, rootB);
  started = Date.now();
  const report = await b.sync.restore();
  const restoreMs = Date.now() - started;
  assert.equal(report.version, flushed.version);
  assert.equal(report.lazy, 1);
  const wikiB = new WikiStore(path.join(rootB, 'brain'));
  assert.deepEqual((await wikiB.listPages()).map((page) => page.id).sort(), ['damping', 'resonance']);
  const raw = path.join(rootB, 'brain/raw/src_photo/rev-1.png');
  assert.equal(await exists(raw), false, 'the image is a stub after restore');
  started = Date.now();
  assert.deepEqual(await wikiB.readSourceBytes('src_photo'), image.bytes);
  const lazyMs = Date.now() - started;
  assert.equal(await exists(raw), true);
  console.log(
    `live sync: pushed ${flushed.pushed} objects in ${pushMs}ms; restored ${report.fetched} files (${(report.bytes / 1024 / 1024).toFixed(1)} MiB) in ${restoreMs}ms; lazy image (${(image.bytes.length / 1024 / 1024).toFixed(1)} MiB) fetched in ${lazyMs}ms`,
  );

  // B edits and pushes; A, now stale, is refused rather than clobbering B.
  await wikiB.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('inertia') }], { inertia: null }));
  await b.sync.flush();
  await wikiA.applyProposal(proposal([{ op: 'upsert_page', page: conceptDraft('friction') }], { friction: null }));
  await assert.rejects(a.sync.push(), SyncConflictError);
  assert.equal(a.sync.state, 'error');

  const rootC = await dataDir('c');
  const c = createVaultSync({ account, flushToken: null }, store, rootC);
  await c.sync.restore();
  assert.deepEqual((await new WikiStore(path.join(rootC, 'brain')).listPages()).map((page) => page.id).sort(), ['damping', 'inertia', 'resonance']);
});
