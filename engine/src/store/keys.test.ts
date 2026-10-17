import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseObjectStoreConfig } from '../config';
import { accountPrefix, assertAccountId, blobKey, ObjectKeyError, syncManifestKey, vaultKey } from './keys';

const hash = 'ab'.repeat(32);

test('vault and blob keys live under one per-account prefix, in separate subtrees', () => {
  assert.equal(vaultKey('acc_1', 'concepts/photosynthesis.md'), 'vaults/acc_1/files/concepts/photosynthesis.md');
  assert.equal(vaultKey('acc_1', '.meta/manifest.json'), 'vaults/acc_1/files/.meta/manifest.json');
  assert.equal(blobKey('acc_1', hash), `vaults/acc_1/blobs/sha256/ab/${hash}`);
  // A vault file named like the blob subtree still lands under files/.
  assert.ok(vaultKey('acc_1', `blobs/sha256/ab/${hash}`).startsWith('vaults/acc_1/files/'));
  assert.equal(accountPrefix('Xy9-AbC'), 'vaults/Xy9-AbC/');
  // The sync manifest sits beside files/ and blobs/, so no vault file can be named onto it.
  assert.equal(syncManifestKey('acc_1'), 'vaults/acc_1/manifest.json');
  assert.notEqual(vaultKey('acc_1', 'manifest.json'), syncManifestKey('acc_1'));
  assert.throws(() => syncManifestKey('../x'), ObjectKeyError);
});

test('account ids are a strict, case-preserving charset', () => {
  for (const id of ['a', 'A1', 'user_01HZX-abc', 'x'.repeat(128)]) assert.equal(assertAccountId(id), id);
  for (const id of ['', '-lead', '_lead', '../x', 'a/b', 'a.b', 'a b', 'é', 'x'.repeat(129), 'a\u0000']) {
    assert.throws(() => vaultKey(id, 'concepts/x.md'), ObjectKeyError, JSON.stringify(id));
  }
});

test('traversal, absolute paths and empty segments are refused', () => {
  for (const rel of ['', '/etc/passwd', '../other/concepts/x.md', 'concepts/../../x', 'concepts/./x.md', '.', '..', 'a//b', 'concepts/', 'a/b/']) {
    assert.throws(() => vaultKey('acc', rel), ObjectKeyError, JSON.stringify(rel));
  }
});

test('control characters, backslashes and line separators are refused', () => {
  for (const rel of ['a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u0085b', 'a b', 'concepts\\..\\x', 'a\\b']) {
    assert.throws(() => vaultKey('acc', rel), ObjectKeyError, JSON.stringify(rel));
  }
});

test('unicode names are allowed only in NFC, with byte-length caps', () => {
  assert.equal(vaultKey('acc', 'concepts/café.md'), 'vaults/acc/files/concepts/café.md');
  assert.equal(vaultKey('acc', 'raw/数学 ノート.pdf'), 'vaults/acc/files/raw/数学 ノート.pdf');
  assert.ok(vaultKey('acc', '.history/a..b.md'));
  assert.throws(() => vaultKey('acc', 'concepts/café.md'), /NFC/);
  // 85 three-byte characters = 255 bytes is the per-segment ceiling.
  assert.ok(vaultKey('acc', `raw/${'数'.repeat(85)}`));
  assert.throws(() => vaultKey('acc', `raw/${'数'.repeat(86)}`), /segment exceeds/);
  assert.throws(() => vaultKey('acc', Array.from({ length: 10 }, () => 'x'.repeat(100)).join('/')), /exceeds 900/);
});

test('blob keys accept only lowercase sha256 hex', () => {
  for (const bad of ['', 'AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}0`, `../${'a'.repeat(61)}`]) {
    assert.throws(() => blobKey('acc', bad), ObjectKeyError, bad);
  }
});

test('object store config is off unless endpoint and bucket are both set', () => {
  assert.equal(parseObjectStoreConfig({}), null);
  assert.equal(parseObjectStoreConfig({ OBJECT_STORE_REGION: 'nyc3', OBJECT_STORE_ACCESS_KEY: 'k' }), null);
  assert.throws(() => parseObjectStoreConfig({ OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9000' }), /both/);
  assert.throws(() => parseObjectStoreConfig({ OBJECT_STORE_BUCKET: 'sef-vaults' }), /both/);
});

test('object store config parses MinIO and Spaces shapes and fails closed on bad values', () => {
  const keys = { OBJECT_STORE_ACCESS_KEY: 'sef-engine', OBJECT_STORE_SECRET_KEY: 'secret-secret' };
  assert.deepEqual(parseObjectStoreConfig({ ...keys, OBJECT_STORE_ENDPOINT: 'http://minio:9000', OBJECT_STORE_BUCKET: 'sef-vaults' }), {
    endpoint: 'http://minio:9000',
    region: 'us-east-1',
    bucket: 'sef-vaults',
    accessKeyId: 'sef-engine',
    secretAccessKey: 'secret-secret',
    forcePathStyle: true,
  });
  const spaces = parseObjectStoreConfig({
    ...keys,
    OBJECT_STORE_ENDPOINT: 'https://blr1.digitaloceanspaces.com/',
    OBJECT_STORE_BUCKET: 'sef-vaults',
    OBJECT_STORE_REGION: 'blr1',
    OBJECT_STORE_FORCE_PATH_STYLE: 'false',
  });
  assert.equal(spaces?.endpoint, 'https://blr1.digitaloceanspaces.com');
  assert.equal(spaces?.forcePathStyle, false);
  const base = { ...keys, OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9000', OBJECT_STORE_BUCKET: 'sef-vaults' };
  for (const [name, value, pattern] of [
    ['OBJECT_STORE_ENDPOINT', 'http://store.example.com', /https/],
    ['OBJECT_STORE_ENDPOINT', 'not a url', /URL/],
    ['OBJECT_STORE_ENDPOINT', 'https://host.example.com/bucket', /origin only/],
    ['OBJECT_STORE_ENDPOINT', 'https://user:pw@host.example.com', /origin only/],
    ['OBJECT_STORE_BUCKET', 'Bad_Bucket', /bucket name/],
    ['OBJECT_STORE_SECRET_KEY', '', /required/],
    ['OBJECT_STORE_FORCE_PATH_STYLE', 'yes', /true or false/],
  ] as const) {
    assert.throws(() => parseObjectStoreConfig({ ...base, [name]: value }), pattern, `${name}=${value}`);
  }
});
