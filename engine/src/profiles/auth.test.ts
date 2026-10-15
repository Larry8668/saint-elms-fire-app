import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
