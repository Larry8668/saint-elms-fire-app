import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { AuthSessionList, DeviceProfile } from '@sef/shared';

const dataDir = await mkdtemp(path.join(tmpdir(), 'sef-http-remote-'));
process.env.ENGINE_DATA_DIR = dataDir;
// Port 9 refuses connections: the uni, models and web are all "unreachable", and no shared service is touched.
process.env.UNI_SERVER_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.SEARXNG_URL = 'http://127.0.0.1:9';

const { createApp } = await import('./app');
const { profilePaths } = await import('../config');
const { MemoryCredentialStore } = await import('../credentials/store');
const { ProfileRegistry } = await import('../profiles/registry');
const { AuthSessions } = await import('../profiles/sessions');
const { AuthService } = await import('../profiles/auth');
const { SettingsStore } = await import('../settings/store');

const SEAT = 'seat.example.test';
const LOCAL = { host: '127.0.0.1:4100' };
/** What the measured Instabox edge sends: loopback Host, the public name in X-Forwarded-Host. */
const viaEdge = (client: string) => ({ host: '127.0.0.1:4100', 'x-forwarded-host': SEAT, 'x-forwarded-for': client, 'x-forwarded-proto': 'https' });
const edgeSocket = { incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 50000, remoteFamily: 'IPv4' } } };

/** Builds an app under the given env; the edge policy is read when the app is created. */
async function harness(env: Record<string, string> = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const credentials = new MemoryCredentialStore();
    const registry = new ProfileRegistry(credentials);
    const sessions = new AuthSessions();
    const settings = new SettingsStore();
    const auth = new AuthService(settings, registry, sessions, credentials, () => Promise.resolve('dev-test'));
    const workspaces = {
      get: async (profile: DeviceProfile) => ({ profile, paths: profilePaths(profile.id) }),
      drop: () => undefined,
    };
    const app = createApp({ settings, auth, workspaces, anonymousData: {} } as never);
    const call = (url: string, init: RequestInit = {}, socket?: object) => app.request(url, { ...init, headers: { ...LOCAL, ...(init.headers as Record<string, string>) } }, socket);
    return { app, call, registry, sessions, settings };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const login = (call: Awaited<ReturnType<typeof harness>>['call'], email: string, password: string, headers: Record<string, string> = {}, socket?: object) =>
  call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, password }) }, socket);

/** Captures console.error lines (warn/error logs) emitted while `fn` runs. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('unauthenticated health is liveness only; the detail needs a session', async () => {
  const { call, registry, sessions } = await harness();
  const live = await call('/api/health');
  assert.equal(live.status, 200);
  const liveBody = (await live.json()) as { ok: boolean; engine: string; uni: object };
  // Exactly these keys, and the uni object is a bare boolean: no url, version, model, host or error text.
  // A session VM with vault sync on adds one more, `sync: { state }` (internal-sync.test.ts); off, never.
  assert.deepEqual(Object.keys(liveBody).sort(), ['engine', 'ok', 'uni']);
  assert.deepEqual(liveBody.uni, { reachable: false });

  assert.equal((await call('/api/health/detail')).status, 401);
  assert.equal((await call('/api/health/detail', { headers: { authorization: 'Bearer guessed' } })).status, 401);

  await registry.ensure({ id: 'health-user', name: 'H', email: 'h@test', cohortId: 'c' }, 'pw');
  const token = await sessions.create('health-user', 'offline');
  const detail = await call('/api/health/detail', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as { ok: boolean; uni: { reachable: boolean }; models: unknown[]; web: { reachable: boolean } };
  assert.equal(body.uni.reachable, false);
  assert.ok(Array.isArray(body.models));
  assert.equal(body.web.reachable, false);
});

test('a hosted seat admits its edge, refuses foreign hosts and origins, and keeps loopback working', async () => {
  const { call } = await harness({ ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' });
  assert.equal((await call('/api/health', { headers: viaEdge('198.51.100.7') }, edgeSocket)).status, 200);
  assert.equal((await call('/api/health', { headers: { ...viaEdge('198.51.100.7'), 'x-forwarded-host': 'evil.example' } }, edgeSocket)).status, 403);
  assert.equal((await call('/api/health', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await call('/api/health')).status, 200, 'a local caller on the box');

  const post = (origin: string) =>
    call('/api/auth/login', { method: 'POST', headers: { ...viaEdge('198.51.100.8'), origin, 'content-type': 'application/json' }, body: '{}' }, edgeSocket);
  assert.equal((await post('https://evil.example')).status, 403);
  assert.equal((await post(`https://${SEAT}`)).status, 400, 'the seat origin reaches the handler (which 400s the empty body)');
  assert.equal((await post('tauri://localhost')).status, 400, 'the Tauri shell stays allowed');

  const preflight = await call('/api/auth/login', { method: 'OPTIONS', headers: { ...viaEdge('198.51.100.8'), origin: `https://${SEAT}`, 'access-control-request-method': 'POST' } }, edgeSocket);
  assert.equal(preflight.headers.get('access-control-allow-origin'), `https://${SEAT}`);
});

test('the sixth bad sign-in in a minute is 429 with retryAfter; good sign-ins never use up the budget', async () => {
  const { call, registry } = await harness();
  await registry.ensure({ id: 'rl-user', name: 'R', email: 'rl@example.test', cohortId: 'c' }, 'right-password');
  for (let i = 0; i < 6; i += 1) assert.equal((await login(call, 'rl@example.test', 'right-password')).status, 200, 'uni down: the offline verifier signs in');

  const warnings = await captureWarnings(async () => {
    for (let i = 0; i < 5; i += 1) assert.equal((await login(call, 'rl@example.test', 'wrong-password')).status, 503);
  });
  const limited = await login(call, 'rl@example.test', 'right-password');
  assert.equal(limited.status, 429, 'even the right password waits once guessing exhausted the window');
  const body = (await limited.json()) as { code: string; retryAfter: number };
  assert.equal(body.code, 'rate_limited');
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 60);
  assert.equal(limited.headers.get('retry-after'), String(body.retryAfter));

  const failures = warnings.filter((line) => line.includes('"auth_failed"'));
  assert.equal(failures.length, 5, 'every bad sign-in is logged');
  for (const line of failures) {
    assert.ok(!line.includes('wrong-password') && !line.includes('rl@example.test'), `no password or email in: ${line}`);
    assert.match(line, /"code":"offline_unknown_profile"/);
  }
});

test('login and offline-login share one guessing budget per client', async () => {
  const { call } = await harness();
  await captureWarnings(async () => {
    for (let i = 0; i < 3; i += 1) await login(call, 'nobody@example.test', 'guess');
    for (let i = 0; i < 2; i += 1) {
      await call('/api/auth/offline-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'guessed' }) });
    }
  });
  assert.equal((await login(call, 'nobody@example.test', 'guess')).status, 429);
  const offline = await call('/api/auth/offline-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'guessed' }) });
  assert.equal(offline.status, 429);
});

test('behind a trusted edge each client has its own bucket — one attacker cannot lock out every student', async () => {
  const { call } = await harness({ ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' });
  await captureWarnings(async () => {
    for (let i = 0; i < 5; i += 1) await login(call, 'nobody@example.test', 'guess', viaEdge('198.51.100.66'), edgeSocket);
  });
  assert.equal((await login(call, 'nobody@example.test', 'guess', viaEdge('198.51.100.66'), edgeSocket)).status, 429);
  // A spoofed left-most hop does not buy the attacker a fresh bucket: the edge appended the real address last.
  assert.equal((await login(call, 'nobody@example.test', 'guess', viaEdge('1.2.3.4, 198.51.100.66'), edgeSocket)).status, 429);
  assert.notEqual((await login(call, 'nobody@example.test', 'guess', viaEdge('198.51.100.77'), edgeSocket)).status, 429, 'another student is unaffected');
});

test('a hosted seat closes the profile picker and the password-less offline unlock', async () => {
  const { call, registry } = await harness({ ENGINE_PUBLIC_HOST: SEAT });
  await registry.ensure({ id: 'listed-user', name: 'L', email: 'l@test', cohortId: 'c' }, 'pw');
  assert.deepEqual(await (await call('/api/auth/profiles')).json(), []);
  const unlock = await call('/api/auth/offline-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'listed-user' }) });
  assert.equal(unlock.status, 403);

  const local = await harness();
  assert.ok(((await (await local.call('/api/auth/profiles')).json()) as unknown[]).length > 0, 'a loopback engine keeps the picker');
});

test('sessions: list own (current marked, no secrets), revoke own, never another profile’s', async () => {
  const { call, registry, sessions } = await harness();
  await registry.ensure({ id: 'owner', name: 'O', email: 'o@test', cohortId: 'c' }, 'pw');
  await registry.ensure({ id: 'other', name: 'X', email: 'x@test', cohortId: 'c' }, 'pw');
  const mine = await sessions.create('owner', 'online', { mode: 'full' }, 'Laptop');
  const lost = await sessions.create('owner', 'offline', { mode: 'full' }, 'Phone');
  const theirs = await sessions.create('other', 'online');
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  assert.equal((await call('/api/auth/sessions')).status, 401);
  const listed = await call('/api/auth/sessions', { headers: as(mine) });
  assert.equal(listed.status, 200);
  const raw = await listed.text();
  for (const secret of [mine, lost, theirs]) assert.ok(!raw.includes(secret), 'no token in the listing');
  assert.ok(!/[0-9a-f]{64}/.test(raw), 'no token hash in the listing');
  const list = (JSON.parse(raw) as AuthSessionList).sessions;
  assert.equal(list.length, 2, 'only the owner’s sessions');
  assert.deepEqual(list.map((s) => [s.deviceLabel, s.current]).sort(), [['Laptop', true], ['Phone', false]]);

  const theirId = ((await (await call('/api/auth/sessions', { headers: as(theirs) })).json()) as AuthSessionList).sessions[0]!.id;
  assert.equal((await call(`/api/auth/sessions/${theirId}`, { method: 'DELETE', headers: as(mine) })).status, 404);
  assert.equal((await call('/api/auth/me', { headers: as(theirs) })).status, 200, 'the other profile’s session survives');

  const phoneId = list.find((s) => s.deviceLabel === 'Phone')!.id;
  assert.equal((await call(`/api/auth/sessions/${phoneId}`, { method: 'DELETE', headers: as(mine) })).status, 204);
  assert.equal((await call('/api/auth/me', { headers: as(lost) })).status, 401, 'the lost device is signed out');
  assert.equal((await call('/api/auth/me', { headers: as(mine) })).status, 200, 'the current one is not');
});

test('a sign-in records the device label it was given, else a User-Agent hint', async () => {
  const { call, registry } = await harness();
  await registry.ensure({ id: 'label-user', name: 'L', email: 'label@example.test', cohortId: 'c' }, 'pw');
  const named = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'label@example.test', password: 'pw', deviceLabel: 'Library PC\u0007' }),
  });
  const { token } = (await named.json()) as { token: string };
  await login(call, 'label@example.test', 'pw', { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' });
  const list = ((await (await call('/api/auth/sessions', { headers: { authorization: `Bearer ${token}` } })).json()) as AuthSessionList).sessions;
  assert.deepEqual(list.map((s) => s.deviceLabel).sort(), ['Library PC', 'Safari on macOS']);
});

test('the served UI: index and SPA routes load, /api is never shadowed, traversal and symlinks are refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sef-static-ui-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>shell</title>');
  await writeFile(path.join(root, 'assets', 'app-abcdef12.js'), 'console.log(1)');
  const secret = path.join(path.dirname(root), `${path.basename(root)}-secret.txt`);
  await writeFile(secret, 'outside the root');
  await symlink(secret, path.join(root, 'leak.txt'));
  const { call } = await harness({ ENGINE_STATIC_DIR: root });

  const index = await call('/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /shell/);
  assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(index.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  assert.equal(index.headers.get('strict-transport-security'), null, 'no HSTS over plain loopback http');

  const asset = await call('/assets/app-abcdef12.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);

  assert.match(await (await call('/brain/wiki')).text(), /shell/, 'client routes fall back to the shell');
  assert.equal((await call('/assets/missing-abcdef12.js')).status, 404, 'a missing asset is not the shell');
  assert.equal((await call('/.env')).status, 404);

  for (const apiPath of ['/api/does-not-exist', '/api/auth/nope', '/api']) {
    const res = await call(apiPath);
    assert.equal(res.status, 404, apiPath);
    assert.doesNotMatch(await res.text(), /shell/, `${apiPath} must never be answered by the UI`);
  }
  assert.equal((await call('/api/health')).status, 200, 'real API routes still win');

  for (const attack of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2f..%2fpackage.json', `/..%2f${path.basename(secret)}`, '/leak.txt']) {
    const res = await call(attack);
    const text = await res.text();
    assert.ok(!text.includes('outside the root') && !text.includes('root:'), `${attack} leaked a file`);
    assert.ok(res.status === 404 || /shell/.test(text), `${attack} answered ${res.status}`);
  }

  assert.equal((await call('/', { headers: { host: 'rebound.evil.test' } })).status, 403, 'the UI is host-gated too');

  const seat = await harness({ ENGINE_STATIC_DIR: root, ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' });
  const overEdge = await seat.call('/', { headers: viaEdge('198.51.100.9') }, edgeSocket);
  assert.equal(overEdge.status, 200);
  assert.match(overEdge.headers.get('strict-transport-security') ?? '', /max-age=/, 'HSTS once a trusted edge reports https');
  const spoofed = await seat.call('/', { headers: { ...viaEdge('198.51.100.9'), 'x-forwarded-host': 'evil.example' } }, edgeSocket);
  assert.equal(spoofed.status, 403);
});

test('without ENGINE_PUBLIC_HOST, a forwarded or non-loopback caller still finds the picker and offline unlock closed', async () => {
  // The fail-open config from the review: a seat named only in ENGINE_ALLOWED_ORIGINS, behind an edge that sends Host: 127.0.0.1.
  const { call, registry } = await harness({ ENGINE_ALLOWED_ORIGINS: `https://${SEAT}`, ENGINE_TRUST_PROXY: '1' });
  await registry.ensure({ id: 'fwd-user', name: 'F', email: 'f@test', cohortId: 'c' }, 'pw');
  const profiles = (headers: Record<string, string>, socket?: object) => call('/api/auth/profiles', { headers }, socket);
  const unlock = (headers: Record<string, string>, socket?: object) =>
    call('/api/auth/offline-login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ profileId: 'fwd-user' }) }, socket);

  const forwarded: Array<Record<string, string>> = [{ 'x-forwarded-for': '198.51.100.9' }, { 'x-forwarded-host': SEAT }, { forwarded: 'for=198.51.100.9;proto=https' }];
  for (const headers of forwarded) {
    // Closed either way: an empty picker, or (for a forwarded host this engine does not own) the Host gate's 403.
    const res = await profiles(headers, edgeSocket);
    const body = await res.json();
    assert.ok(res.status === 403 || (Array.isArray(body) && body.length === 0), `${JSON.stringify(headers)} -> ${JSON.stringify(body)}`);
    assert.equal((await unlock(headers, edgeSocket)).status, 403, JSON.stringify(headers));
  }
  const lanSocket = { incoming: { socket: { remoteAddress: '172.17.0.1', remotePort: 50000, remoteFamily: 'IPv4' } } };
  assert.deepEqual(await (await profiles({}, lanSocket)).json(), [], 'a non-loopback peer is remote');
  assert.equal((await unlock({}, lanSocket)).status, 403);

  const ids = async (socket: object) => ((await (await profiles({}, socket)).json()) as Array<{ id: string }>).map((p) => p.id);
  assert.ok((await ids(edgeSocket)).includes('fwd-user'), 'a plain loopback caller is the device');
  const v6Socket = { incoming: { socket: { remoteAddress: '::ffff:127.0.0.1', remotePort: 50000, remoteFamily: 'IPv6' } } };
  assert.ok((await ids(v6Socket)).includes('fwd-user'), 'IPv4-mapped loopback is the device');
});

test('ENGINE_DEVICE_PEERS lets a container count its bridge gateway as the device, never a forwarded request', async () => {
  const { call, registry } = await harness({ ENGINE_DEVICE_PEERS: '172.16.0.0/12' });
  await registry.ensure({ id: 'peer-user', name: 'P', email: 'p@test', cohortId: 'c' }, 'pw');
  const gateway = { incoming: { socket: { remoteAddress: '172.18.0.1', remotePort: 50000, remoteFamily: 'IPv4' } } };
  const stranger = { incoming: { socket: { remoteAddress: '10.0.0.5', remotePort: 50000, remoteFamily: 'IPv4' } } };
  const listed = (await (await call('/api/auth/profiles', {}, gateway)).json()) as Array<{ id: string }>;
  assert.ok(listed.some((p) => p.id === 'peer-user'));
  assert.deepEqual(await (await call('/api/auth/profiles', {}, stranger)).json(), []);
  assert.deepEqual(await (await call('/api/auth/profiles', { headers: { 'x-forwarded-for': '6.6.6.6' } }, gateway)).json(), []);
});

const start = (call: Awaited<ReturnType<typeof harness>>['call'], client: string) => call('/api/auth/device/start', { method: 'POST', headers: viaEdge(client) }, edgeSocket);

test('device starts are limited per client and across the whole engine', async () => {
  const { call } = await harness({ ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' });
  // The uni is down, so each start 503s — but each one still cost an upstream call and counts.
  for (let i = 0; i < 5; i += 1) assert.equal((await start(call, '198.51.100.20')).status, 503);
  const limited = await start(call, '198.51.100.20');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  // 15 more starts from other clients fill the engine-wide budget of 20 a minute.
  for (let i = 0; i < 15; i += 1) assert.equal((await start(call, `198.51.100.${30 + i}`)).status, 503);
  assert.equal((await start(call, '198.51.100.99')).status, 429, 'a fresh address is still capped engine-wide');
});

test('over HTTP, a stranger starting a device sign-in does not clobber the student polling theirs', async () => {
  const uni = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/auth/device/code') {
      res.end(JSON.stringify({ device_code: `dc-${Math.random()}`, user_code: 'ABCD-EFGH', verification_uri: 'https://uni.test/device', expires_in: 600, interval: 5 }));
      return;
    }
    res.writeHead(400).end(JSON.stringify({ error: 'authorization_pending' }));
  });
  await new Promise<void>((resolve) => uni.listen(0, '127.0.0.1', resolve));
  try {
    const address = uni.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const { call, settings } = await harness({ ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' });
    await settings.update({ uniServerUrl: `http://127.0.0.1:${port}` });
    const poll = (client: string, body?: object) =>
      call('/api/auth/device/poll', { method: 'POST', headers: { ...viaEdge(client), 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }, edgeSocket);

    const victim = (await (await start(call, '203.0.113.1')).json()) as { flowKey: string };
    for (let i = 0; i < 3; i += 1) assert.equal((await start(call, '203.0.113.66')).status, 200, 'the attacker starts their own grants');
    const after = await poll('203.0.113.1', { flowKey: victim.flowKey });
    assert.equal(after.status, 200);
    assert.equal(((await after.json()) as { status: string }).status, 'pending', 'the victim keeps their flow');
    assert.equal((await poll('203.0.113.66')).status, 400, 'a keyless remote poll finds nothing');
  } finally {
    uni.close();
  }
});

test('password sign-ins forwarded to the uni have an engine-wide cap; successes refund it', async () => {
  const { call, registry } = await harness({ ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' });
  await registry.ensure({ id: 'global-user', name: 'G', email: 'global@example.test', cohortId: 'c' }, 'right-password');
  const from = (client: string, password: string) => login(call, 'global@example.test', password, viaEdge(client), edgeSocket);
  await captureWarnings(async () => {
    // Two attacker addresses, well inside their own per-client budgets.
    for (let i = 0; i < 4; i += 1) assert.equal((await from('198.51.100.1', 'guess')).status, 503);
    for (let i = 0; i < 3; i += 1) assert.equal((await from('198.51.100.2', 'guess')).status, 503);
  });
  // Students signing in successfully never use up the engine-wide budget.
  for (let i = 0; i < 10; i += 1) assert.equal((await from(`203.0.113.${i + 1}`, 'right-password')).status, 200);
  await captureWarnings(async () => {
    assert.equal((await from('198.51.100.2', 'guess')).status, 503, 'the eighth failure in the minute still reaches the handler');
  });
  const capped = await from('203.0.113.50', 'right-password');
  assert.equal(capped.status, 429, 'a fresh address waits once eight attempts are in flight or failed');
  assert.ok(Number(capped.headers.get('retry-after')) > 0);
  assert.equal(((await capped.json()) as { code: string }).code, 'rate_limited');
});

test('IPv6 clients behind the edge are limited per /64, not per address', async () => {
  const { call } = await harness({ ENGINE_PUBLIC_HOST: SEAT, ENGINE_TRUST_PROXY: '1' });
  await captureWarnings(async () => {
    for (let i = 1; i <= 5; i += 1) await login(call, 'nobody@example.test', 'guess', viaEdge(`2001:db8:5:6::${i.toString(16)}`), edgeSocket);
  });
  assert.equal((await login(call, 'nobody@example.test', 'guess', viaEdge('2001:db8:5:6:ffff::1'), edgeSocket)).status, 429, 'a fresh address in the same /64');
  assert.notEqual((await login(call, 'nobody@example.test', 'guess', viaEdge('2001:db8:5:7::1'), edgeSocket)).status, 429, 'the next /64 is someone else');
});
