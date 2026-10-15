import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DeviceProfile, EngineMe } from '@sef/shared';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-http-security-'));

const { createApp } = await import('./app');
const { profilePaths } = await import('../config');
const { MemoryCredentialStore } = await import('../credentials/store');
const { ProfileRegistry } = await import('../profiles/registry');
const { AuthSessions } = await import('../profiles/sessions');
const { AuthService } = await import('../profiles/auth');
const { SettingsStore } = await import('../settings/store');
const { signToken } = await import('@sef/shared/node');

/** A real auth service over throwaway storage; uni calls never happen (no network used). */
async function harness() {
  const credentials = new MemoryCredentialStore();
  const registry = new ProfileRegistry(credentials);
  const sessions = new AuthSessions();
  const auth = new AuthService(new SettingsStore(), registry, sessions, credentials, () => Promise.resolve('dev-test'));
  const dropped: string[] = [];
  const workspaces = {
    get: async (profile: DeviceProfile) => ({
      profile,
      paths: profilePaths(profile.id),
      content: { installed: async () => ({}), allLessons: async () => [] },
    }),
    drop: (id: string) => void dropped.push(id),
  };
  const deps = {
    settings: new SettingsStore(),
    auth,
    workspaces,
    anonymousData: { preview: async () => ({}), backup: async () => ({}), claim: async () => ({}) },
  };
  const app = createApp(deps as never);
  return { app, registry, sessions, dropped };
}

const post = (app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response }, path: string, headers: Record<string, string> = {}, body = '{}') =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:4100', ...headers }, body });

test('hostile Origins on mutating requests are rejected before any handler', async () => {
  const { app } = await harness();
  const hostile = await post(app, '/api/auth/login', { origin: 'https://evil.example' });
  assert.equal(hostile.status, 403);
  assert.equal((await hostile.json() as { code: string }).code, 'forbidden_origin');

  // Same URL, no Origin (curl/native) — reaches the handler (which 400s on the empty body).
  const native = await post(app, '/api/auth/login');
  assert.equal(native.status, 400);
});

test('non-loopback Host headers are rejected (DNS rebinding)', async () => {
  const { app } = await harness();
  const res = await app.request('/api/health', { headers: { host: 'attacker.example' } });
  assert.equal(res.status, 403);
  const rebound = await post(app, '/api/auth/login', { host: 'rebound.evil.test' });
  assert.equal(rebound.status, 403);
});

test('guessed sessions get 401 on every protected surface', async () => {
  const { app } = await harness();
  const guessed = await app.request('/api/library', { headers: { authorization: 'Bearer made-up', host: '127.0.0.1:4100' } });
  assert.equal(guessed.status, 401);
  const settings = await app.request('/api/settings', { headers: { authorization: 'Bearer made-up', host: '127.0.0.1:4100' } });
  assert.equal(settings.status, 401);
});

test('unapproved device profiles reach /api/auth/me but nothing else', async () => {
  const { app, registry, sessions } = await harness();
  await registry.recordDeviceSignIn(
    { id: 'pending-user', name: 'Pending', email: 'p@test' },
    'uni-session-token',
    new Date(Date.now() + 86400000).toISOString(),
    'pending',
    '',
  );
  const token = await sessions.create('pending-user', 'online');

  const me = await app.request('/api/auth/me', { headers: { authorization: `Bearer ${token}`, host: '127.0.0.1:4100' } });
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { profile: { admission: string } }).profile.admission, 'pending');

  const library = await app.request('/api/library', { headers: { authorization: `Bearer ${token}`, host: '127.0.0.1:4100' } });
  assert.equal(library.status, 403);
  assert.equal((await library.json() as { code: string }).code, 'unapproved');

  const settings = await app.request('/api/settings', { headers: { authorization: `Bearer ${token}`, host: '127.0.0.1:4100' } });
  assert.equal(settings.status, 403);
});

test('approved device profiles pass the gate; guessed profile ids cannot unlock offline', async () => {
  const { app, registry, sessions } = await harness();
  await registry.recordDeviceSignIn(
    { id: 'approved-user', name: 'A', email: 'a@test' },
    'uni-session',
    new Date(Date.now() + 86400000).toISOString(),
    'approved',
    'cohort-a',
  );
  const token = await sessions.create('approved-user', 'online');
  const library = await app.request('/api/library', { headers: { authorization: `Bearer ${token}`, host: '127.0.0.1:4100' } });
  assert.equal(library.status, 200);

  const unlock = await post(app, '/api/auth/offline-login', {}, JSON.stringify({ profileId: 'no-such-profile' }));
  assert.equal(unlock.status, 401);
});

test('logout kills the session and drops the profile workspace', async () => {
  const { app, registry, sessions, dropped } = await harness();
  await registry.ensure({ id: 'demo-user', name: 'Demo', email: 'd@test', cohortId: 'c' }, 'pw');
  const token = await sessions.create('demo-user', 'offline');
  const headers = { authorization: `Bearer ${token}`, host: '127.0.0.1:4100' };
  assert.equal((await app.request('/api/auth/me', { headers })).status, 200);
  const out = await app.request('/api/auth/logout', { method: 'POST', headers });
  assert.equal(out.status, 204);
  assert.deepEqual(dropped, ['demo-user']);
  assert.equal((await app.request('/api/auth/me', { headers })).status, 401);
});

test('a uni-issued token never authorizes an engine session', async () => {
  // Engine sessions are opaque hashed tokens — a sef1/uni token is not one, whatever its claims.
  const { app } = await harness();
  const { generateKeyPairSync } = await import('node:crypto');
  const forgedUni = signToken(
    { iss: 'saint-elms', sub: 'x', role: 'admin', name: 'x', email: 'x', iat: 0, exp: 9999999999 },
    generateKeyPairSync('ed25519').privateKey,
  );
  const res = await app.request('/api/settings', { headers: { authorization: `Bearer ${forgedUni}`, host: '127.0.0.1:4100' } });
  assert.equal(res.status, 401);
});
