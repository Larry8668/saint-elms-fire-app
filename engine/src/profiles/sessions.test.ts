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

test('hashed rows from before session ids keep working, gain a stable id, and are never signed out', async () => {
  const { createHash } = await import('node:crypto');
  const token = 'legacy-but-hashed-token';
  const key = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  await writeFile(config.paths.authSessions, JSON.stringify({ [key]: { profileId: 'elder', mode: 'online', expiresAt } }));

  const first = new AuthSessions();
  assert.equal((await first.resolve(token))?.profileId, 'elder', 'the legacy session still signs in');
  const [listed] = await first.list('elder', token);
  assert.ok(listed && /^[0-9a-f]{32}$/.test(listed.id) && listed.id !== key.slice(0, 32), 'an id that is not the token hash');
  assert.equal(listed.createdAt, null, 'unknown issue time is reported as unknown, not invented');
  assert.equal(listed.deviceLabel, 'Unknown device');
  assert.equal(listed.current, true);

  const reloaded = new AuthSessions();
  assert.equal((await reloaded.list('elder'))[0]?.id, listed.id, 'the id is stable across reloads');
  assert.equal(await reloaded.revokeById('elder', listed.id), true);
  assert.equal(await reloaded.resolve(token), null);
});

test('lastSeenAt is refreshed at most every few minutes, not on every request', async () => {
  const sessions = new AuthSessions();
  const token = await sessions.create('frequent', 'online');
  const before = (await sessionFile()) as Record<string, { lastSeenAt: string }>;
  for (let i = 0; i < 20; i += 1) await sessions.resolve(token);
  assert.deepEqual(await sessionFile(), before, 'no rewrite while lastSeenAt is fresh');

  // Age the row past the resolution: the next resolve records the visit once.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const aged = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, { ...v, lastSeenAt: v.lastSeenAt && stale }]));
  await writeFile(config.paths.authSessions, JSON.stringify(aged));
  const reloaded = new AuthSessions();
  await reloaded.resolve(token);
  const row = Object.values((await sessionFile()) as Record<string, { profileId: string; lastSeenAt: string }>).find((r) => r.profileId === 'frequent')!;
  assert.ok(Date.parse(row.lastSeenAt) > Date.parse(stale));
});

test('revokeById never reaches another profile’s session', async () => {
  const sessions = new AuthSessions();
  const victim = await sessions.create('victim', 'online');
  const [row] = await sessions.list('victim');
  assert.equal(await sessions.revokeById('attacker', row!.id), false);
  assert.equal((await sessions.resolve(victim))?.profileId, 'victim');
});
