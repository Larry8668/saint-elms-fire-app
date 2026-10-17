import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { blobKey, vaultKey } from './keys';
import { type ObjectStore, ObjectStoreError, PreconditionFailedError } from './object-store';

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

/**
 * The behaviour every ObjectStore must share, run against the in-memory store in unit tests and
 * against real MinIO in the integration test. Each run writes under a fresh account prefix.
 */
export function objectStoreContract(name: string, makeStore: () => ObjectStore, options: { skip?: boolean | string } = {}) {
  const account = `test-${randomUUID()}`;
  const store = options.skip ? (undefined as unknown as ObjectStore) : makeStore();
  const run = (title: string, body: () => Promise<void>) => test(`${name}: ${title}`, { skip: options.skip }, body);

  run('put/get/head roundtrip text with its content type and an MD5 etag', async () => {
    const key = vaultKey(account, 'concepts/photosynthesis.md');
    const text = '# Photosynthesis\n\nLight → sugar.\n';
    const { etag } = await store.put(key, text, { contentType: 'text/markdown; charset=utf-8' });
    assert.equal(etag, md5(new TextEncoder().encode(text)));
    const got = await store.get(key);
    assert.ok(got);
    assert.equal(new TextDecoder().decode(got.body), text);
    assert.equal(got.etag, etag);
    assert.equal(got.contentType, 'text/markdown; charset=utf-8');
    const head = await store.head(key);
    assert.equal(head?.size, Buffer.byteLength(text));
    assert.equal(head?.etag, etag);
  });

  run('missing keys read as null and delete is idempotent', async () => {
    const key = vaultKey(account, 'questions/never-written.md');
    assert.equal(await store.get(key), null);
    assert.equal(await store.head(key), null);
    await store.delete(key);
    await store.put(key, 'x');
    await store.delete(key);
    assert.equal(await store.get(key), null);
  });

  run('list pages through a prefix in key order and never leaks a sibling prefix', async () => {
    const names = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    for (const file of names) await store.put(vaultKey(account, `sources/${file}`), file);
    await store.put(vaultKey(account, 'sources-other/z.md'), 'z');
    const prefix = vaultKey(account, 'sources/x').slice(0, -1);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.list(prefix, { limit: 2, cursor });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((item) => item.key));
      cursor = page.cursor;
      pages += 1;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen, names.map((file) => vaultKey(account, `sources/${file}`)));
    const page = await store.list(prefix);
    assert.equal(page.cursor, undefined);
    assert.equal(page.items[0].etag, md5(new TextEncoder().encode('a.md')));
  });

  run('ifNoneMatch "*" creates once and refuses to overwrite', async () => {
    const key = vaultKey(account, '.meta/journal/0001.json');
    await store.put(key, '{"first":true}', { contentType: 'application/json', ifNoneMatch: '*' });
    await assert.rejects(store.put(key, '{"first":false}', { ifNoneMatch: '*' }), PreconditionFailedError);
    const got = await store.get(key);
    assert.equal(new TextDecoder().decode(got!.body), '{"first":true}');
  });

  run('ifMatch swaps only while the etag is current, and refuses a missing key', async () => {
    const key = vaultKey(account, '.meta/cas.json');
    const first = await store.put(key, '{"v":1}', { ifNoneMatch: '*' });
    const second = await store.put(key, '{"v":2}', { ifMatch: first.etag });
    await assert.rejects(store.put(key, '{"v":3}', { ifMatch: first.etag }), PreconditionFailedError);
    assert.equal(new TextDecoder().decode((await store.get(key))!.body), '{"v":2}');
    assert.equal((await store.head(key))?.etag, second.etag);
    await assert.rejects(store.put(vaultKey(account, '.meta/never.json'), 'x', { ifMatch: first.etag }), PreconditionFailedError);
  });

  run('unicode and URL-hostile names round-trip through put, list and get', async () => {
    const paths = ['concepts/naïve café.md', 'raw/数学 ノート.pdf', 'syntheses/a+b=c %20 & <x>.md'];
    for (const rel of paths) await store.put(vaultKey(account, rel), rel);
    const listed = (await store.list(vaultKey(account, 'x').slice(0, -1))).items.map((item) => item.key);
    for (const rel of paths) {
      assert.ok(listed.includes(vaultKey(account, rel)), `listed ${rel}`);
      assert.equal(new TextDecoder().decode((await store.get(vaultKey(account, rel)))!.body), rel);
    }
  });

  run('a 6 MiB binary blob round-trips byte for byte under its content address', async () => {
    const bytes = new Uint8Array(randomBytes(6 * 1024 * 1024));
    const key = blobKey(account, createHash('sha256').update(bytes).digest('hex'));
    await store.put(key, bytes, { contentType: 'video/mp4' });
    const got = await store.get(key);
    assert.equal(got?.size, bytes.byteLength);
    assert.ok(Buffer.from(got!.body).equals(Buffer.from(bytes)));
  });

  run('keys with dot or empty segments are refused before any request', async () => {
    for (const key of [`vaults/${account}/files/../other`, `vaults/${account}//x`, './x', '']) {
      await assert.rejects(store.put(key, 'x'), ObjectStoreError, key);
    }
  });

  run('cleanup: everything under the run prefix deletes', async () => {
    const prefix = `vaults/${account}/`;
    let cursor: string | undefined;
    do {
      const page = await store.list(prefix, { cursor });
      for (const item of page.items) await store.delete(item.key);
      cursor = page.cursor;
    } while (cursor);
    assert.deepEqual((await store.list(prefix)).items, []);
  });
}
