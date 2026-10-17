import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ENGINE_AUDIENCE, type DeviceProfile } from '@sef/shared';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-limited-access-'));
/** Port 9 (discard) refuses connections — anything the fake uni does not cover is "offline". */
process.env.UNI_SERVER_URL = 'http://127.0.0.1:9';

const { createApp } = await import('./app');
const { config, profilePaths } = await import('../config');
const { MemoryCredentialStore } = await import('../credentials/store');
const { ProfileRegistry } = await import('../profiles/registry');
const { AuthSessions } = await import('../profiles/sessions');
const { AuthService } = await import('../profiles/auth');
const { SettingsStore } = await import('../settings/store');
const { signToken } = await import('@sef/shared/node');

const uniKeys = generateKeyPairSync('ed25519');
const uniPublicPem = uniKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const pinUniKey = () => mkdir(config.paths.trust, { recursive: true }).then(() => writeFile(path.join(config.paths.trust, 'uni-public.pem'), uniPublicPem));

const issueEntitlement = (profileId: string, dev: string, overrides: Record<string, unknown> = {}) =>
  signToken(
    {
      iss: 'saint-elms.test',
      sub: profileId,
      role: 'student',
      name: 'A',
      email: 'a@test',
      cohortId: 'cohort-a',
      aud: ENGINE_AUDIENCE,
      dev,
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    },
    uniKeys.privateKey,
  );

const expired = { exp: Math.floor(Date.now() / 1000) - 60 };

/** A real app over throwaway storage; every uni call either hits the fake uni below or nothing. */
async function harness() {
  const credentials = new MemoryCredentialStore();
  const registry = new ProfileRegistry(credentials);
  const sessions = new AuthSessions();
  const settings = new SettingsStore();
  const auth = new AuthService(settings, registry, sessions, credentials, () => Promise.resolve('dev-test'));
  const workspaces = {
    get: async (profile: DeviceProfile) => ({
      profile,
      paths: profilePaths(profile.id),
      content: { installed: async () => ({}), allLessons: async () => [] },
      brain: { pages: async () => [] },
      settings: { get: async () => ({ uniServerUrl: '', searxngUrl: '', thinking: true, providers: [], roles: {} }) },
      portable: { exportVault: async () => ({ schemaVersion: 2, counts: { files: 3, bytes: 42 }, skipped: [] }) },
    }),
    drop: () => {},
  };
  const deps = {
    settings,
    auth,
    workspaces,
    anonymousData: { preview: async () => ({}), backup: async () => ({}), claim: async () => ({}) },
  };
  const app = createApp(deps as never);
  return { app, auth, registry, sessions, settings };
}

type App = Awaited<ReturnType<typeof harness>>['app'];

const call = (app: App, method: string, path: string, token?: string, body?: string) =>
  app.request(path, {
    method,
    headers: {
      host: '127.0.0.1:4100',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

/** The uni's device-grant and /v1/me surface, just real enough for the engine's device sign-in. */
async function fakeUni(enrolment: Record<string, unknown> | null): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url === '/v1/auth/device/code') {
      return json({ device_code: 'device-code-1', user_code: 'ABCD-EFGH', verification_uri: 'http://uni.test/device', expires_in: 600, interval: 1 });
    }
    if (req.method === 'POST' && req.url === '/v1/auth/device/token') {
      return json({ access_token: 'uni-session-1', expires_in: 3600 });
    }
    if (req.method === 'GET' && req.url === '/v1/me') {
      return json({
        schemaVersion: 2,
        user: { id: 'student-1', email: 's@test', name: 'Sam', emailVerified: true },
        studentId: 'student-1',
        enrolment,
        staffRoles: [],
      });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const offlineLogin = async (app: App, profileId: string) => {
  const res = await call(app, 'POST', '/api/auth/offline-login', undefined, JSON.stringify({ profileId }));
  const body = (await res.json().catch(() => null)) as { token: string; access?: { mode: string; reason?: string } } | null;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body);
  return body;
};

test('an expired but validly signed entitlement admits a limited offline session', async () => {
  await pinUniKey();
  const { app, registry } = await harness();
  await registry.recordDeviceSignIn({ id: 'expired-student', name: 'E', email: 'e@test' }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), 'approved', 'cohort-a');
  await registry.recordEntitlement('expired-student', issueEntitlement('expired-student', 'dev-test', expired));

  const login = await offlineLogin(app, 'expired-student');
  assert.deepEqual(login.access, { mode: 'limited', reason: 'entitlement_expired' });

  const me = await call(app, 'GET', '/api/auth/me', login.token);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json() as { access: unknown }).access, { mode: 'limited', reason: 'entitlement_expired' });
});

test('a limited session reads everywhere but every mutation answers 403 access_limited', async () => {
  await pinUniKey();
  const { app, registry } = await harness();
  await registry.recordDeviceSignIn({ id: 'limited-student', name: 'L', email: 'l@test' }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), 'approved', 'cohort-a');
  await registry.recordEntitlement('limited-student', issueEntitlement('limited-student', 'dev-test', expired));
  const { token } = await offlineLogin(app, 'limited-student');

  assert.equal((await call(app, 'GET', '/api/library', token)).status, 200);
  assert.equal((await call(app, 'GET', '/api/brain/pages', token)).status, 200);
  assert.equal((await call(app, 'GET', '/api/settings', token)).status, 200);

  for (const [method, path] of [
    ['POST', '/api/sources'],
    ['PUT', '/api/settings'],
    ['POST', '/api/chat/sessions'],
    ['POST', '/api/quiz/some-key'],
    ['DELETE', '/api/sessions/some-session'],
    ['POST', '/api/logistics'],
  ] as const) {
    const res = await call(app, method, path, token, method === 'DELETE' ? undefined : '{}');
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json() as { code: string }).code, 'access_limited', `${method} ${path}`);
  }
});

test('the vault export stays open to a limited session; import and its preview stay shut', async () => {
  await pinUniKey();
  const { app, registry } = await harness();
  await registry.recordDeviceSignIn({ id: 'exporter', name: 'X', email: 'x@test' }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), 'approved', 'cohort-a');
  await registry.recordEntitlement('exporter', issueEntitlement('exporter', 'dev-test', expired));
  const { token } = await offlineLogin(app, 'exporter');

  const exported = await call(app, 'POST', '/api/vault/export', token, '{}');
  assert.equal(exported.status, 200);
  assert.equal((await exported.json() as { counts: { files: number } }).counts.files, 3);

  for (const path of ['/api/vault/import', '/api/vault/import/preview'] as const) {
    const res = await call(app, 'POST', path, token, '{}');
    assert.equal(res.status, 403, path);
    assert.equal((await res.json() as { code: string }).code, 'access_limited', path);
  }
});

test('a limited session can always sign itself out', async () => {
  await pinUniKey();
  const { app, registry } = await harness();
  await registry.recordDeviceSignIn({ id: 'leaver', name: 'V', email: 'v@test' }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), 'approved', 'cohort-a');
  await registry.recordEntitlement('leaver', issueEntitlement('leaver', 'dev-test', expired));
  const { token } = await offlineLogin(app, 'leaver');

  assert.equal((await call(app, 'POST', '/api/auth/logout', token, '{}')).status, 204);
  assert.equal((await call(app, 'GET', '/api/auth/me', token)).status, 401);
});

test('a live entitlement still unlocks a full session', async () => {
  await pinUniKey();
  const { app, registry } = await harness();
  await registry.recordDeviceSignIn({ id: 'full-student', name: 'F', email: 'f@test' }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), 'approved', 'cohort-a');
  await registry.recordEntitlement('full-student', issueEntitlement('full-student', 'dev-test'));
  const { token, access } = await offlineLogin(app, 'full-student');
  assert.deepEqual(access, { mode: 'full' });

  // Reaches the handler, which rejects the empty body — proof the gate let it through.
  const write = await call(app, 'POST', '/api/sources', token, '{}');
  assert.equal(write.status, 400);
  assert.equal((await write.json() as { code: string }).code, 'invalid_request');
});

test('a suspended or withdrawn enrolment makes even a valid entitlement limited offline', async () => {
  await pinUniKey();
  const { app, registry } = await harness();
  for (const [admission, reason] of [
    ['suspended', 'admission_suspended'],
    ['withdrawn', 'admission_withdrawn'],
  ] as const) {
    const id = `offline-${admission}`;
    await registry.recordDeviceSignIn({ id, name: 'S', email: `${admission}@test` }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), admission, 'cohort-a');
    await registry.recordEntitlement(id, issueEntitlement(id, 'dev-test'));
    const { access } = await offlineLogin(app, id);
    assert.deepEqual(access, { mode: 'limited', reason }, admission);
  }
});

test('an enrolment state the uni reports outranks local entitlement expiry', async () => {
  await pinUniKey();
  const { app, registry } = await harness();
  await registry.recordDeviceSignIn({ id: 'both-gone', name: 'B', email: 'b@test' }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), 'suspended', 'cohort-a');
  await registry.recordEntitlement('both-gone', issueEntitlement('both-gone', 'dev-test', expired));
  const { access } = await offlineLogin(app, 'both-gone');
  assert.deepEqual(access, { mode: 'limited', reason: 'admission_suspended' });
});

test('device sign-in with a suspended or withdrawn enrolment yields a limited session, not a refusal', async () => {
  for (const [status, reason] of [
    ['suspended', 'admission_suspended'],
    ['withdrawn', 'admission_withdrawn'],
  ] as const) {
    const uni = await fakeUni({ status, cohortId: status === 'suspended' ? 'cohort-a' : null, programmeId: 'prog' });
    try {
      const { app, auth, settings } = await harness();
      await settings.update({ uniServerUrl: uni.url });
      const { flowKey } = await auth.startDeviceSignIn();
      const result = await auth.pollDeviceSignIn({ flowKey });
      assert.ok(result.status === 'approved', status);
      assert.equal(result.profile.admission, status);
      assert.deepEqual(result.access, { mode: 'limited', reason }, status);

      // The limited session reads its own files even though the admission gate still says unapproved.
      assert.equal((await call(app, 'GET', '/api/library', result.token)).status, 200);
      const write = await call(app, 'POST', '/api/sources', result.token, '{}');
      assert.equal(write.status, 403);
      assert.equal((await write.json() as { code: string }).code, 'access_limited');
      assert.equal((await call(app, 'POST', '/api/vault/export', result.token, '{}')).status, 200);
    } finally {
      await uni.close();
    }
  }
});

test('pending applicants keep their old confinement: /api/auth/* and nothing else', async () => {
  const { app, registry, sessions } = await harness();
  await registry.recordDeviceSignIn({ id: 'pending-student', name: 'P', email: 'p@test' }, 'uni-session', new Date(Date.now() + 86400000).toISOString(), 'pending', '');
  const token = await sessions.create('pending-student', 'online');

  const me = await call(app, 'GET', '/api/auth/me', token);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json() as { access: unknown }).access, { mode: 'full' }, 'confinement is the approved gate, not a limited session');

  for (const [method, path] of [
    ['GET', '/api/library'],
    ['POST', '/api/sources'],
    ['PUT', '/api/settings'],
  ] as const) {
    const res = await call(app, method, path, token, method === 'GET' ? undefined : '{}');
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json() as { code: string }).code, 'unapproved', `${method} ${path}`);
  }
});
