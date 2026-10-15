import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheControlFor, contentTypeFor, etagFor, nonce, resolveAsset } from './static-files';

const root = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-portal-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  await writeFile(path.join(dir, 'assets', 'app-12345678.js'), 'console.log(1)');
  return dir;
};

test('a normal asset path resolves inside the root', async () => {
  const dir = await root();
  const asset = await resolveAsset(dir, 'index.html');
  assert.equal(asset?.relative, 'index.html');
  assert.equal(asset && (await asset.file).endsWith('index.html'), true);
});

test('traversal never escapes the root', async () => {
  const dir = await root();
  await writeFile(path.join(dir, '..', 'sef-portal-secret.txt'), 'secret');
  for (const attempt of ['../sef-portal-secret.txt', '../../etc/passwd', 'assets/../../etc/passwd', '/etc/passwd', 'a/../../escape']) {
    assert.equal(await resolveAsset(dir, attempt), null, attempt);
  }
});

test('a null byte in the path is refused rather than truncated', async () => {
  const dir = await root();
  assert.equal(await resolveAsset(dir, 'index.html\0.txt'), null);
});

test('a directory is not served as a file', async () => {
  const dir = await root();
  assert.equal(await resolveAsset(dir, 'assets'), null);
  assert.equal(await resolveAsset(dir, ''), null);
});

test('a symlink pointing outside the root is refused', async () => {
  const dir = await root();
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'sef-outside-')), 'leak.js');
  await writeFile(outside, 'leak');
  await symlink(outside, path.join(dir, 'leak.js'));
  assert.equal(await resolveAsset(dir, 'leak.js'), null);
});

test('a symlink staying inside the root is served', async () => {
  const dir = await root();
  await symlink(path.join(dir, 'index.html'), path.join(dir, 'inside.html'));
  assert.equal((await resolveAsset(dir, 'inside.html'))?.relative, 'inside.html');
});

test('a symlinked directory inside the root cannot be used to read outside it', async () => {
  const dir = await root();
  const outside = await mkdtemp(path.join(tmpdir(), 'sef-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  // The final component is an ordinary file, so only resolving the whole path catches this.
  await symlink(outside, path.join(dir, 'escape'));

  assert.equal(await resolveAsset(dir, 'escape/secret.txt'), null);
  assert.equal(await resolveAsset(dir, 'escape'), null);
});

test('the ETag tracks the bytes, so a rewritten asset cannot get a stale 304', () => {
  const before = etagFor(Buffer.from('<!doctype html><title>shell</title>'));
  const after = etagFor(Buffer.from('<!doctype html><title>changed</title>'));
  assert.match(before, /^"[A-Za-z0-9_-]{27}"$/);
  assert.equal(etagFor(Buffer.from('<!doctype html><title>shell</title>')), before);
  assert.notEqual(after, before);
});

test('content types are explicit for portal assets and default to binary', () => {
  assert.equal(contentTypeFor('a/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('a/app-12345678.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('a/logo.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('a/unknown.xyz'), 'application/octet-stream');
});

test('only hashed assets are cached immutably', () => {
  assert.equal(cacheControlFor('assets/app-12345678.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('index.html'), 'no-cache');
  assert.equal(cacheControlFor('assets/app.js'), 'no-cache');
});

test('nonces are unique and URL-safe', () => {
  const a = nonce();
  const b = nonce();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9+/]+={0,2}$/);
});
