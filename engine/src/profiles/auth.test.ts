import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ENGINE_AUDIENCE } from '@sef/shared';
import { signToken } from '@sef/shared/node';

const dataDir = await mkdtemp(path.join(tmpdir(), 'sef-engine-'));
process.env.ENGINE_DATA_DIR = dataDir;
/** Port 9 (discard) refuses connections, which is exactly "the uni is unreachable". */
process.env.UNI_SERVER_URL = 'http://127.0.0.1:9';

const { AuthService, AuthError } = await import('./auth');
const { ProfileRegistry } = await import('./registry');
const { AuthSessions } = await import('./sessions');
const { MemoryCredentialStore } = await import('../credentials/store');
const { SettingsStore } = await import('../settings/store');
const { config } = await import('../config');

const uniKeys = generateKeyPairSync('ed25519');
const uniPublicPem = uniKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function offlineHarness(device = 'dev-test') {
  const credentials = new MemoryCredentialStore();
  const registry = new ProfileRegistry(credentials);
  const sessions = new AuthSessions();
  const auth = new AuthService(new SettingsStore(), registry, sessions, credentials, () => Promise.resolve(device));
  await registry.ensure({ id: 'ananya', name: 'Ananya', email: 'ananya@saintelms.local', cohortId: 'bsc-pma-2026' }, 'harbor-lantern');
  return { auth, registry, credentials, sessions };
}

/** A fresh registry+service reading the shared data dir (for cross-instance checks). */
async function reload(device = 'dev-test') {
  const credentials = new MemoryCredentialStore();
  const registry = new ProfileRegistry(credentials);
  const sessions = new AuthSessions();
  const auth = new AuthService(new SettingsStore(), registry, sessions, credentials, () => Promise.resolve(device));
  return { auth, registry, credentials, sessions };
}

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
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    },
    uniKeys.privateKey,
  );

const pinUniKey = () => mkdir(config.paths.trust, { recursive: true }).then(() => writeFile(path.join(config.paths.trust, 'uni-public.pem'), uniPublicPem));

test('offline sign-in works with the cached verifier', async () => {
  const { auth } = await offlineHarness();
  const res = await auth.login('ananya@saintelms.local', 'harbor-lantern');
  assert.equal(res.role, 'student');
  assert.ok(res.role === 'student' && res.mode === 'offline');
  const me = await auth.resolve(res.role === 'student' ? res.token : '');
  assert.equal(me?.profile.id, 'ananya');
  assert.equal(me?.profile.offlineReady, true);
});

test('offline sign-in rejects a wrong password and unknown accounts', async () => {
  const { auth } = await offlineHarness();
  await assert.rejects(auth.login('ananya@saintelms.local', 'nope'), AuthError);
  await assert.rejects(auth.login('stranger@saintelms.local', 'harbor-lantern'), (e: unknown) => e instanceof AuthError && e.code === 'offline_unknown_profile');
});

test('logout revokes the engine session', async () => {
  const { auth } = await offlineHarness();
  const res = await auth.login('ananya@saintelms.local', 'harbor-lantern');
  const token = res.role === 'student' ? res.token : '';
  await auth.logout(token);
  assert.equal(await auth.resolve(token), null);
});

test('device sign-in records admission and never a password verifier', async () => {
  const { registry } = await offlineHarness();
  const profile = await registry.recordDeviceSignIn(
    { id: 'new-student', name: 'New', email: 'n@test' },
    'uni-session-token',
    new Date(Date.now() + 86400000).toISOString(),
    'approved',
    'cohort-a',
    'bsc-physics',
  );
  assert.equal(profile.admission, 'approved');
  assert.equal(profile.cohortId, 'cohort-a');
  assert.equal(profile.programmeId, 'bsc-physics', 'the programme is part of the stored identity');
  // No password path exists for this profile.
  assert.equal(await registry.verifyOffline('n@test', 'anything'), null);
  // But the uni session credential resolves.
  assert.equal(await registry.uniToken('new-student'), 'uni-session-token');
});

test('first-time users cannot unlock offline — no entitlement, no entry', async () => {
  const { auth, registry } = await offlineHarness();
  await registry.recordDeviceSignIn(
    { id: 'never-offline', name: 'N', email: 'n2@test' },
    'uni-session',
    new Date(Date.now() + 86400000).toISOString(),
    'pending',
    '',
  );
  await assert.rejects(auth.unlockOffline('never-offline'), (e: unknown) => e instanceof AuthError && e.code === 'offline_locked');
  assert.equal(await auth.unlockOffline('guessed-id'), null);
});

test('a verified entitlement unlocks offline; tampered and wrong-device credentials do not', async () => {
  await pinUniKey();
  const { auth, registry } = await offlineHarness();
  await registry.recordDeviceSignIn(
    { id: 'dev-student', name: 'D', email: 'd@test' },
    'uni-session',
    new Date(Date.now() + 86400000).toISOString(),
    'approved',
    'cohort-a',
  );

  await registry.recordEntitlement('dev-student', issueEntitlement('dev-student', 'dev-test'));
  const res = await auth.unlockOffline('dev-student');
  assert.ok(res && res.role === 'student' && res.mode === 'offline');
  assert.deepEqual(res.role === 'student' && res.access, { mode: 'full' });

  // Same student, entitlement minted for a different device — refused.
  await registry.recordEntitlement('dev-student', issueEntitlement('dev-student', 'other-device'));
  await assert.rejects(auth.unlockOffline('dev-student'), (e: unknown) => e instanceof AuthError && e.code === 'offline_locked');

  // Forged signature — refused.
  const forged = signToken(
    { iss: 'evil', sub: 'dev-student', role: 'student', name: 'x', email: 'x', aud: ENGINE_AUDIENCE, dev: 'dev-test', iat: 0, exp: 9999999999 },
    generateKeyPairSync('ed25519').privateKey,
  );
  await registry.recordEntitlement('dev-student', forged);
  await assert.rejects(auth.unlockOffline('dev-student'), (e: unknown) => e instanceof AuthError && e.code === 'offline_locked');
});

test('legacy plaintext uni tokens in profiles.json migrate into the credential store', async () => {
  const legacy = [
    {
      id: 'legacy-user',
      name: 'Legacy',
      email: 'l@test',
      cohortId: 'cohort-a',
      verifier: 'x',
      uniToken: 'sef1.legacy.token',
      uniTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  ];
  await writeFile(config.paths.profiles, JSON.stringify(legacy));
  const { registry, credentials } = await reload();
  assert.equal(await registry.uniToken('legacy-user'), 'sef1.legacy.token');
  assert.equal(await credentials.get('uni-session:legacy-user'), 'sef1.legacy.token');
  const rows = JSON.parse(await (await import('node:fs/promises')).readFile(config.paths.profiles, 'utf8')) as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.uniToken, undefined, 'plaintext token must be stripped from profiles.json');
});

test('logout clears uni credentials and entitlement while keeping the profile', async () => {
  const { auth, registry, credentials, sessions } = await offlineHarness();
  await registry.recordDeviceSignIn(
    { id: 'logout-user', name: 'L', email: 'lu@test' },
    'uni-session',
    new Date(Date.now() + 86400000).toISOString(),
    'approved',
    'cohort-a',
  );
  await registry.recordEntitlement('logout-user', 'entitlement-token');
  const token = await sessions.create('logout-user', 'offline');
  await auth.logout(token);
  assert.equal(await credentials.get('uni-session:logout-user'), null);
  assert.equal(await credentials.get('entitlement:logout-user'), null);
  const profile = await registry.get('logout-user');
  assert.ok(profile, 'profile record stays for the picker');
  assert.equal(profile!.offlineReady, false);
});

test('staff accounts are refused and sent to the /admin portal, never relayed', async () => {
  const uni = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/auth/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          token: 'sef1.staff.token',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          account: { id: 'admin', email: 'admin@saintelms.local', name: 'Registrar', role: 'admin', createdAt: new Date().toISOString() },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => uni.listen(0, '127.0.0.1', resolve));
  try {
    const address = uni.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const settings = new SettingsStore(path.join(dataDir, 'settings-staff-refusal.json'));
    await settings.update({ uniServerUrl: `http://127.0.0.1:${port}` });
    const credentials = new MemoryCredentialStore();
    const registry = new ProfileRegistry(credentials);
    const auth = new AuthService(settings, registry, new AuthSessions(), credentials);
    await assert.rejects(auth.login('admin@saintelms.local', 'harbor-lantern'), (e: unknown) => e instanceof AuthError && e.code === 'staff_use_portal');
    assert.equal(await registry.get('admin'), undefined, 'no student profile is recorded for a staff account');
  } finally {
    uni.close();
  }
});

test('a device grant can only be polled by the client that started it, when the key is required', async () => {
  const uni = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/auth/device/code') {
      res.end(JSON.stringify({ device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'https://uni.test/device', expires_in: 600, interval: 5 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/auth/device/token') {
      res.writeHead(400).end(JSON.stringify({ error: 'authorization_pending' }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => uni.listen(0, '127.0.0.1', resolve));
  try {
    const address = uni.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const settings = new SettingsStore(path.join(dataDir, 'settings-flow-key.json'));
    await settings.update({ uniServerUrl: `http://127.0.0.1:${port}` });
    const credentials = new MemoryCredentialStore();
    const auth = new AuthService(settings, new ProfileRegistry(credentials), new AuthSessions(), credentials);
    const grant = await auth.startDeviceSignIn({ allowKeyless: true });
    assert.ok(grant.flowKey && grant.flowKey.length >= 32);

    const noFlow = (e: unknown) => e instanceof AuthError && e.code === 'no_device_flow';
    await assert.rejects(auth.pollDeviceSignIn({ requireFlowKey: true }), noFlow, 'a stranger without the key');
    await assert.rejects(auth.pollDeviceSignIn({ flowKey: 'guessed', requireFlowKey: true }), noFlow, 'a wrong key');
    await assert.rejects(auth.pollDeviceSignIn({ flowKey: 'guessed' }), noFlow, 'a wrong key is refused even when optional');
    assert.equal((await auth.pollDeviceSignIn({ flowKey: grant.flowKey, requireFlowKey: true })).status, 'pending');
    assert.equal((await auth.pollDeviceSignIn()).status, 'pending', 'a loopback engine keeps keyless polls working');
  } finally {
    uni.close();
  }
});

/** A uni whose device grants are numbered dc-1, dc-2…; it records which device_code each poll named, and denies any in `deny`. */
async function deviceUni(expiresIn = 600) {
  let issued = 0;
  const polled: string[] = [];
  const deny = new Set<string>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/auth/device/code') {
        issued += 1;
        res.end(JSON.stringify({ device_code: `dc-${issued}`, user_code: `CODE-${issued}`, verification_uri: 'https://uni.test/device', expires_in: expiresIn, interval: 5 }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/device/token') {
        const code = (JSON.parse(raw) as { device_code: string }).device_code;
        polled.push(code);
        res.writeHead(400).end(JSON.stringify({ error: deny.has(code) ? 'access_denied' : 'authorization_pending' }));
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const settings = new SettingsStore(path.join(dataDir, `settings-device-${port}.json`));
  await settings.update({ uniServerUrl: `http://127.0.0.1:${port}` });
  return { settings, polled, deny, issued: () => issued, close: () => server.close() };
}

const noFlow = (e: unknown) => e instanceof AuthError && e.code === 'no_device_flow';

function deviceAuth(settings: InstanceType<typeof SettingsStore>, options: { maxPendingFlows?: number; now?: () => number } = {}) {
  const credentials = new MemoryCredentialStore();
  return new AuthService(settings, new ProfileRegistry(credentials), new AuthSessions(), credentials, () => Promise.resolve('dev-test'), options);
}

test('concurrent device sign-ins each poll their own grant; a stranger starting one cancels nobody', async () => {
  const uni = await deviceUni();
  try {
    const auth = deviceAuth(uni.settings);
    const victim = await auth.startDeviceSignIn();
    const attacker = await auth.startDeviceSignIn();
    assert.notEqual(victim.flowKey, attacker.flowKey);
    assert.equal((await auth.pollDeviceSignIn({ flowKey: victim.flowKey, requireFlowKey: true })).status, 'pending', 'the victim still has their flow');
    assert.equal((await auth.pollDeviceSignIn({ flowKey: attacker.flowKey, requireFlowKey: true })).status, 'pending');
    assert.deepEqual(uni.polled, ['dc-1', 'dc-2'], 'each key polls its own device code');

    // One grant ending (denied) leaves the other in flight.
    uni.deny.add('dc-2');
    assert.equal((await auth.pollDeviceSignIn({ flowKey: attacker.flowKey, requireFlowKey: true })).status, 'denied');
    await assert.rejects(auth.pollDeviceSignIn({ flowKey: attacker.flowKey, requireFlowKey: true }), noFlow, 'a finished grant is gone');
    assert.equal((await auth.pollDeviceSignIn({ flowKey: victim.flowKey, requireFlowKey: true })).status, 'pending');
    assert.equal(auth.pendingDeviceFlows, 1);
  } finally {
    uni.close();
  }
});

test('pending device grants are bounded: the oldest is dropped past the cap, and expired ones by TTL', async () => {
  const uni = await deviceUni(600);
  try {
    let now = 1_000_000;
    const auth = deviceAuth(uni.settings, { maxPendingFlows: 3, now: () => now });
    const grants = [];
    for (let i = 0; i < 5; i += 1) grants.push(await auth.startDeviceSignIn());
    assert.equal(auth.pendingDeviceFlows, 3);
    for (const dropped of grants.slice(0, 2)) await assert.rejects(auth.pollDeviceSignIn({ flowKey: dropped.flowKey }), noFlow);
    for (const kept of grants.slice(2)) assert.equal((await auth.pollDeviceSignIn({ flowKey: kept.flowKey })).status, 'pending');

    now += 601_000; // past the uni's 600 s expiry
    assert.equal((await auth.pollDeviceSignIn({ flowKey: grants[2]!.flowKey })).status, 'expired', 'the starting client hears expired');
    assert.equal(auth.pendingDeviceFlows, 2);
    now += 10 * 60_000; // well past the grace period
    await auth.startDeviceSignIn();
    assert.equal(auth.pendingDeviceFlows, 1, 'the next start evicted every expired grant');
  } finally {
    uni.close();
  }
});

test('keyless polls are for the device itself: they find the latest grant started there, never a remote one', async () => {
  const uni = await deviceUni();
  try {
    const auth = deviceAuth(uni.settings);
    await assert.rejects(auth.pollDeviceSignIn(), noFlow, 'nothing started yet');
    await auth.startDeviceSignIn({ allowKeyless: true }); // dc-1, the app on this device
    const remote = await auth.startDeviceSignIn(); // dc-2, a visitor through the edge
    assert.equal((await auth.pollDeviceSignIn()).status, 'pending');
    assert.deepEqual(uni.polled, ['dc-1'], 'the keyless poll skipped the remote grant');
    await assert.rejects(auth.pollDeviceSignIn({ requireFlowKey: true }), noFlow, 'a remote caller must bring a key');
    await auth.startDeviceSignIn({ allowKeyless: true }); // dc-3
    await auth.pollDeviceSignIn();
    assert.equal(uni.polled.at(-1), 'dc-3', 'the most recent local grant');
    assert.equal((await auth.pollDeviceSignIn({ flowKey: remote.flowKey, requireFlowKey: true })).status, 'pending', 'the visitor is undisturbed');
  } finally {
    uni.close();
  }
});
