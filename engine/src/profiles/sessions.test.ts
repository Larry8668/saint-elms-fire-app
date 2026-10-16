import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = await mkdtemp(path.join(tmpdir(), 'sef-sessions-'));
process.env.ENGINE_DATA_DIR = dataDir;

const { AuthSessions } = await import('./sessions');
const { config } = await import('../config');

const sessionFile = async () => JSON.parse(await readFile(config.paths.authSessions, 'utf8')) as Record<string, unknown>;

test('session tokens are stored hashed, never in plaintext', async () => {
  const sessions = new AuthSessions();
  const token = await sessions.create('ananya', 'offline');
  const file = await sessionFile();
  const keys = Object.keys(file);
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, /^[0-9a-f]{64}$/);
  assert.ok(!keys.includes(token), 'raw token must not be a storage key');
  assert.equal(await sessions.resolve(token).then((s) => s?.profileId), 'ananya');
});

test('guessed and tampered tokens resolve to nothing', async () => {
  const sessions = new AuthSessions();
  assert.equal(await sessions.resolve('not-a-real-token'), null);
  const token = await sessions.create('ananya', 'offline');
  assert.equal(await sessions.resolve(`${token}x`), null);
});

test('legacy plaintext-keyed sessions are dropped on load', async () => {
  // config.paths was fixed at import; seeding that file with a pre-hash row simulates an old install.
  await writeFile(config.paths.authSessions, JSON.stringify({ 'plaintext-token': { profileId: 'x', mode: 'offline', expiresAt: new Date(Date.now() + 86400000).toISOString() } }));
  const sessions = new AuthSessions();
  assert.equal(await sessions.resolve('plaintext-token'), null);
  assert.deepEqual(Object.keys(await sessionFile()), []);
});

test('revokeForProfile kills every session of that profile and none of others', async () => {
  const sessions = new AuthSessions();
  const a1 = await sessions.create('ananya', 'offline');
  const a2 = await sessions.create('ananya', 'online');
  const b1 = await sessions.create('brinda', 'offline');
  await sessions.revokeForProfile('ananya');
  assert.equal(await sessions.resolve(a1), null);
  assert.equal(await sessions.resolve(a2), null);
  assert.equal(await sessions.resolve(b1).then((s) => s?.profileId), 'brinda');
});

test('the access decided at issue time persists across a reload', async () => {
  const sessions = new AuthSessions();
  const limited = await sessions.create('carina', 'offline', { mode: 'limited', reason: 'entitlement_expired' });
  const plain = await sessions.create('devi', 'offline');
  // A fresh instance re-reads the file: the access marker must survive the round trip.
  const reloaded = new AuthSessions();
  assert.deepEqual((await reloaded.resolve(limited))?.access, { mode: 'limited', reason: 'entitlement_expired' });
  assert.deepEqual((await reloaded.resolve(plain))?.access, { mode: 'full' });
});
