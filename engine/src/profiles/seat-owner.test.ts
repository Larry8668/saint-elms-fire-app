import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = await mkdtemp(path.join(tmpdir(), 'sef-seat-'));
process.env.ENGINE_DATA_DIR = dataDir;

const { AuthService, AuthError } = await import('./auth');
const { ProfileRegistry } = await import('./registry');
const { AuthSessions } = await import('./sessions');
const { SeatOwner, enforceSeatOwner } = await import('./seat-owner');
const { MemoryCredentialStore } = await import('../credentials/store');
const { SettingsStore } = await import('../settings/store');
const { profilePaths } = await import('../config');

const PASSWORD = 'harbor-lantern';

/** A uni with password accounts and a device flow that approves as `deviceUser`. */
async function stubUni() {
  const state = { deviceUser: '' };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/auth/login') {
        const { email } = JSON.parse(raw) as { email: string };
        const id = email.split('@')[0]!;
        res.end(
          JSON.stringify({
            token: `uni-${id}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            account: { id, email, name: id, role: 'student', createdAt: new Date().toISOString() },
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/device/code') {
        res.end(JSON.stringify({ device_code: `dc-${state.deviceUser}`, user_code: 'ABCD-EFGH', verification_uri: 'https://uni.test/device', expires_in: 600, interval: 5 }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/device/token') {
        const user = (JSON.parse(raw) as { device_code: string }).device_code.slice(3);
        res.end(JSON.stringify({ access_token: `tok-${user}`, token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/me') {
        const user = (req.headers.authorization ?? '').replace(/^Bearer tok-/, '');
        res.end(JSON.stringify({ schemaVersion: 1, user: { id: user, email: `${user}@test`, name: user, emailVerified: true }, studentId: null, enrolment: null, staffRoles: [] }));
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const settings = new SettingsStore(path.join(dataDir, `settings-${port}.json`));
  await settings.update({ uniServerUrl: `http://127.0.0.1:${port}` });
  return { settings, state, close: () => server.close() };
}

let seq = 0;
async function harness(seatOptions: { hosted: boolean; envOwner?: string; file?: string }) {
  const uni = await stubUni();
  const file = seatOptions.file ?? path.join(dataDir, `seat-owner-${++seq}.json`);
  const seat = new SeatOwner({ ...seatOptions, file });
  const credentials = new MemoryCredentialStore();
  const registry = new ProfileRegistry(credentials);
  const sessions = new AuthSessions();
  const auth = new AuthService(uni.settings, registry, sessions, credentials, () => Promise.resolve('dev-test'), { seat });
  const deviceSignIn = async (user: string) => {
    uni.state.deviceUser = user;
    const grant = await auth.startDeviceSignIn();
    return auth.pollDeviceSignIn({ flowKey: grant.flowKey, requireFlowKey: true });
  };
  return { uni, file, seat, credentials, registry, sessions, auth, deviceSignIn };
}

const notYours = (e: unknown) => e instanceof AuthError && e.code === 'seat_not_yours' && e.message === 'This seat belongs to another student.';

/** Nothing of the refused account was written: no profile row, no verifier, no workspace, no uni credential. */
async function assertNothingOnDisk(h: Awaited<ReturnType<typeof harness>>, id: string) {
  assert.equal(await h.registry.get(id), undefined, 'no profile');
  assert.equal(await h.registry.verifyOffline(`${id}@test`, PASSWORD), null, 'no verifier');
  const stored = await readFile(path.join(dataDir, 'profiles.json'), 'utf8').catch(() => '[]');
  assert.ok(!stored.includes(`"${id}"`), 'profiles.json never names the account');
  assert.equal(existsSync(profilePaths(id, dataDir).root), false, 'no workspace');
  assert.equal(await h.credentials.get(`uni-session:${id}`), null, 'no uni credential');
}

test('ENGINE_SEAT_OWNER is enforced on password sign-in and the device flow', async () => {
  const h = await harness({ hosted: true, envOwner: 'env-owner' });
  try {
    await assert.rejects(h.auth.login('env-intruder@test', PASSWORD), notYours);
    await assert.rejects(h.deviceSignIn('env-intruder'), notYours);
    await assertNothingOnDisk(h, 'env-intruder');
    const owner = await h.auth.login('env-owner@test', PASSWORD);
    assert.equal(owner.profile.id, 'env-owner');
    assert.equal((await h.deviceSignIn('env-owner')).status, 'approved');
    assert.equal(existsSync(h.file), false, 'an env owner is never written to the pin file');
  } finally {
    h.uni.close();
  }
});

test('the first uni-verified sign-in pins the seat; a second account is refused and leaves nothing behind', async () => {
  const h = await harness({ hosted: true });
  try {
    const first = await h.deviceSignIn('tofu-owner');
    assert.equal(first.status, 'approved');
    const pin = JSON.parse(await readFile(h.file, 'utf8')) as { accountId: string };
    assert.equal(pin.accountId, 'tofu-owner');

    await assert.rejects(h.auth.login('tofu-second@test', PASSWORD), notYours);
    await assert.rejects(h.deviceSignIn('tofu-second'), notYours);
    await assertNothingOnDisk(h, 'tofu-second');
    assert.equal((await h.auth.login('tofu-owner@test', PASSWORD)).profile.id, 'tofu-owner');
  } finally {
    h.uni.close();
  }
});

test('concurrent first sign-ins pin exactly one owner', async () => {
  const seat = new SeatOwner({ hosted: true, file: path.join(dataDir, 'seat-race.json') });
  const results = await Promise.all(['race-a', 'race-b', 'race-c'].map((id) => seat.claim(id)));
  assert.deepEqual(results, [true, false, false]);
});

test('the pin survives a restart', async () => {
  const h = await harness({ hosted: true });
  try {
    await h.auth.login('restart-owner@test', PASSWORD);
    const restarted = await harness({ hosted: true, file: h.file });
    try {
      await assert.rejects(restarted.auth.login('restart-other@test', PASSWORD), notYours);
      assert.equal((await restarted.auth.login('restart-owner@test', PASSWORD)).profile.id, 'restart-owner');
    } finally {
      restarted.uni.close();
    }
  } finally {
    h.uni.close();
  }
});

test('a local engine is unchanged: two profiles sign in, nothing is pinned', async () => {
  const h = await harness({ hosted: false });
  try {
    const a = await h.auth.login('local-a@test', PASSWORD);
    const b = await h.auth.login('local-b@test', PASSWORD);
    assert.equal((await h.deviceSignIn('local-c')).status, 'approved');
    assert.equal((await h.auth.resolve(a.token))?.profile.id, 'local-a');
    assert.equal((await h.auth.resolve(b.token))?.profile.id, 'local-b');
    assert.equal(existsSync(h.file), false);
  } finally {
    h.uni.close();
  }
});

test('a corrupt pin fails closed: every sign-in is refused and no session is honoured', async () => {
  const file = path.join(dataDir, 'seat-corrupt.json');
  await writeFile(file, '{"accountId": ');
  const h = await harness({ hosted: true, file });
  try {
    const before = await h.sessions.create('corrupt-owner', 'online');
    assert.equal((await enforceSeatOwner(h.seat, h.sessions)).kind, 'corrupt');
    await assert.rejects(h.auth.login('corrupt-owner@test', PASSWORD), notYours);
    await assert.rejects(h.deviceSignIn('corrupt-owner'), notYours);
    await assertNothingOnDisk(h, 'corrupt-owner');
    assert.equal(await h.auth.resolve(before), null);
    assert.equal(await readFile(file, 'utf8'), '{"accountId": ', 'the broken pin is never overwritten');
  } finally {
    h.uni.close();
  }
});

test('startup revokes sessions other profiles hold once a pin exists', async () => {
  const h = await harness({ hosted: true });
  try {
    const owner = await h.auth.login('sweep-owner@test', PASSWORD);
    // Issued before the pin existed (an older engine): another profile's session.
    const stale = await h.sessions.create('sweep-other', 'online');
    const sessions = new AuthSessions();
    const seat = new SeatOwner({ hosted: true, file: h.file });
    const state = await enforceSeatOwner(seat, sessions);
    assert.equal(state.kind, 'owner');
    assert.equal(await sessions.resolve(stale), null, 'the foreign session is gone from disk');
    assert.equal((await sessions.resolve(owner.token))?.profileId, 'sweep-owner');
  } finally {
    h.uni.close();
  }
});

test('offline paths never pin an unclaimed seat', async () => {
  const h = await harness({ hosted: true });
  await h.registry.ensure({ id: 'offline-only', name: 'O', email: 'offline-only@test', cohortId: '' }, PASSWORD);
  await h.uni.settings.update({ uniServerUrl: 'http://127.0.0.1:9' });
  try {
    await assert.rejects(h.auth.login('offline-only@test', PASSWORD), (e: unknown) => e instanceof AuthError && e.code === 'offline_unknown_profile');
    await assert.rejects(h.auth.unlockOffline('offline-only'), (e: unknown) => e instanceof AuthError && e.code === 'offline_unknown_profile');
    assert.equal(existsSync(h.file), false);
  } finally {
    h.uni.close();
  }
});
