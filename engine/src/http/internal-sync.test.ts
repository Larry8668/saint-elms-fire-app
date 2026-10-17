import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DeviceProfile } from '@sef/shared';

const dataDir = await mkdtemp(path.join(tmpdir(), 'sef-http-sync-'));
process.env.ENGINE_DATA_DIR = dataDir;
process.env.UNI_SERVER_URL = 'http://127.0.0.1:9';

const { createApp } = await import('./app');
const { profilePaths } = await import('../config');
const { MemoryCredentialStore } = await import('../credentials/store');
const { ProfileRegistry } = await import('../profiles/registry');
const { AuthSessions } = await import('../profiles/sessions');
const { AuthService } = await import('../profiles/auth');
const { SettingsStore } = await import('../settings/store');
const { MemoryObjectStore } = await import('../store');
const { VaultSync } = await import('../sync');
const { parseVaultSyncConfig } = await import('../sync/config');

const TOKEN = 'flush-token-0123456789abcdef-xyz';
const LOCAL = { host: '127.0.0.1:4100' };
const loopback = { incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 50000, remoteFamily: 'IPv4' } } };
const loopback6 = { incoming: { socket: { remoteAddress: '::1', remotePort: 50000, remoteFamily: 'IPv6' } } };
const lan = { incoming: { socket: { remoteAddress: '192.168.1.20', remotePort: 50000, remoteFamily: 'IPv4' } } };
/** What the Instabox edge sends to a hosted seat: it connects from loopback and always forwards. */
const viaEdge = { 'x-forwarded-host': 'seat.example.test', 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' };

async function harness(options: { restored?: boolean; env?: Record<string, string>; flushToken?: string | null } = {}) {
  const saved = Object.fromEntries(Object.keys(options.env ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, options.env ?? {});
  try {
    const root = await mkdtemp(path.join(tmpdir(), 'sef-http-sync-profile-'));
    const store = new MemoryObjectStore();
    const sync = new VaultSync({ store, account: 'stu_1', root });
    if (options.restored !== false) await sync.restore();
    const credentials = new MemoryCredentialStore();
    const registry = new ProfileRegistry(credentials);
    const settings = new SettingsStore();
    const auth = new AuthService(settings, registry, new AuthSessions(), credentials, () => Promise.resolve('dev-test'));
    const workspaces = { get: async (profile: DeviceProfile) => ({ profile, paths: profilePaths(profile.id) }), drop: () => undefined };
    const vaultSync = { sync, flushToken: options.flushToken === undefined ? TOKEN : options.flushToken };
    const app = createApp({ settings, auth, workspaces, anonymousData: {}, vaultSync } as never);
    const call = (url: string, init: RequestInit = {}, socket?: object) => app.request(url, { ...init, headers: { ...LOCAL, ...(init.headers as Record<string, string>) } }, socket);
    const flush = (headers: Record<string, string> = {}, socket: object | null = loopback) =>
      call('/api/internal/sync/flush', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers } }, socket ?? undefined);
    return { call, flush, sync, store, root };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('flush: a loopback caller with the token gets {ok, pushed, version} once everything is pushed', async () => {
  const { flush, root } = await harness();
  await mkdir(path.join(root, 'brain/concepts'), { recursive: true });
  await writeFile(path.join(root, 'brain/concepts/a.md'), '# A\n');
  const response = await flush();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pushed: 1, version: 1 });
  assert.equal((await flush({}, loopback6)).status, 200, '::1 is loopback too');
});

test('flush: refused off loopback, without a socket, and with any forwarding header', async () => {
  const { flush } = await harness();
  assert.equal((await flush({}, lan)).status, 403);
  assert.equal((await flush({}, null)).status, 403, 'no socket peer is not proof of loopback');
  for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip']) {
    assert.equal((await flush({ [header]: '127.0.0.1' })).status, 403, header);
  }
});

test('flush: a hosted seat’s public traffic can never reach it, even though the edge connects from loopback', async () => {
  const { call, flush } = await harness({ env: { ENGINE_PUBLIC_HOST: 'seat.example.test', ENGINE_TRUST_PROXY: '1' } });
  assert.equal((await call('/api/health', { headers: viaEdge }, loopback)).status, 200, 'the edge itself is admitted');
  const response = await flush(viaEdge, loopback);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'forbidden' });
  assert.equal((await flush({}, loopback)).status, 200, 'session-stop.sh on the box still works');
});

test('flush: a wrong, missing or unconfigured token is refused', async () => {
  const { flush, call } = await harness();
  assert.equal((await flush({ authorization: 'Bearer nope' })).status, 401);
  assert.equal((await flush({ authorization: `Bearer ${TOKEN}x` })).status, 401);
  assert.equal((await call('/api/internal/sync/flush', { method: 'POST' }, loopback)).status, 401);
  const shut = await harness({ flushToken: null });
  assert.equal((await shut.flush()).status, 401, 'no SYNC_FLUSH_TOKEN: the endpoint stays shut');
});

test('flush before the restore finished is refused: it would push an empty vault over the real one', async () => {
  const { flush } = await harness({ restored: false });
  const response = await flush();
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, 'not_restored');
});

test('public health adds one word of sync state, and nothing else of the student’s is served until restored', async () => {
  const { call, sync } = await harness({ restored: false });
  const live = await call('/api/health');
  const body = (await live.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['engine', 'ok', 'sync', 'uni']);
  assert.deepEqual(body.sync, { state: 'restoring' });
  assert.deepEqual(body.uni, { reachable: false });
  const gated = await call('/api/auth/me');
  assert.equal(gated.status, 503);
  assert.equal(((await gated.json()) as { code: string }).code, 'vault_restoring');

  await sync.restore();
  assert.deepEqual(((await (await call('/api/health')).json()) as { sync: unknown }).sync, { state: 'ready' });
  assert.notEqual((await call('/api/auth/me')).status, 503);
});

test('sync config: off without the account or the store, strict once on', () => {
  const store = { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true };
  assert.equal(parseVaultSyncConfig({}, store).config, null);
  assert.equal(parseVaultSyncConfig({ VAULT_SYNC_ACCOUNT: 'stu_1' }, null).config, null);
  assert.deepEqual(parseVaultSyncConfig({ VAULT_SYNC_ACCOUNT: 'stu_1', SYNC_FLUSH_TOKEN: TOKEN }, store).config, { account: 'stu_1', flushToken: TOKEN });
  assert.equal(parseVaultSyncConfig({ VAULT_SYNC_ACCOUNT: 'stu_1', SYNC_FLUSH_TOKEN: 'short' }, store).config?.flushToken, null);
  assert.throws(() => parseVaultSyncConfig({ VAULT_SYNC_ACCOUNT: '../x' }, store));
  assert.throws(() => parseVaultSyncConfig({ VAULT_SYNC_ACCOUNT: 'stu_1', ENGINE_SEAT_OWNER: 'stu_2' }, store), /seat owner/);
});
