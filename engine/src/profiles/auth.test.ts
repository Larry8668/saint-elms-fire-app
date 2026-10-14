import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-engine-'));
/** Port 9 (discard) refuses connections, which is exactly "the uni is unreachable". */
process.env.UNI_SERVER_URL = 'http://127.0.0.1:9';

const { AuthService, AuthError } = await import('./auth');
const { ProfileRegistry } = await import('./registry');
const { AuthSessions } = await import('./sessions');
const { SettingsStore } = await import('../settings/store');

async function offlineHarness() {
  const registry = new ProfileRegistry();
  const auth = new AuthService(new SettingsStore(), registry, new AuthSessions());
  await registry.ensure({ id: 'ananya', name: 'Ananya', email: 'ananya@saintelms.local', cohortId: 'bsc-pma-2026' }, 'harbor-lantern');
  return auth;
}

test('offline sign-in works with the cached verifier', async () => {
  const auth = await offlineHarness();
  const res = await auth.login('ananya@saintelms.local', 'harbor-lantern');
  assert.equal(res.role, 'student');
  assert.ok(res.role === 'student' && res.mode === 'offline');
  const me = await auth.resolve(res.role === 'student' ? res.token : '');
  assert.equal(me?.profile.id, 'ananya');
  assert.equal(me?.profile.offlineReady, true);
});

test('offline sign-in rejects a wrong password and unknown accounts', async () => {
  const auth = await offlineHarness();
  await assert.rejects(auth.login('ananya@saintelms.local', 'nope'), AuthError);
  await assert.rejects(auth.login('stranger@saintelms.local', 'harbor-lantern'), (e: unknown) => e instanceof AuthError && e.code === 'offline_unknown_profile');
});

test('logout revokes the engine session', async () => {
  const auth = await offlineHarness();
  const res = await auth.login('ananya@saintelms.local', 'harbor-lantern');
  const token = res.role === 'student' ? res.token : '';
  await auth.logout(token);
  assert.equal(await auth.resolve(token), null);
});
