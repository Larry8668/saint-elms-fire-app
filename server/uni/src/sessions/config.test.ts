import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppOrigin, parseSessionConfig, parseWorkspaceOrigins } from './config';
import { flushErrorCode, healthVerdict, sessionStartEnvs } from './orchestrator';

const base = { INSTABOX_API_KEY: 'ibk_x', SEF_GOLDEN_SNAPSHOT_ID: 'sn_agquvqu6h2bc33n7w2bfctcxni' };

test('the orchestrator is off unless both the key and the snapshot are set', () => {
  assert.equal(parseSessionConfig({}), null);
  assert.equal(parseSessionConfig({ INSTABOX_API_KEY: 'ibk_x' }), null);
  assert.equal(parseSessionConfig({ SEF_GOLDEN_SNAPSHOT_ID: base.SEF_GOLDEN_SNAPSHOT_ID }), null);
});

test('defaults: 3 concurrent (quota 5, the operator box takes one), 15 idle minutes, object store passthrough', () => {
  const config = parseSessionConfig({ ...base, OBJECT_STORE_BUCKET: 'sef-vaults', OBJECT_STORE_ENDPOINT: ' ' }, 'https://uni.example.test/')!;
  assert.equal(config.maxConcurrent, 3);
  assert.equal(config.idleMinutes, 15);
  assert.equal(config.uniPublicUrl, 'https://uni.example.test');
  assert.deepEqual(config.objectStore, { OBJECT_STORE_BUCKET: 'sef-vaults' });
  assert.equal(config.gatewaySecret, null);
  assert.equal(parseSessionConfig({ ...base, SESSION_MAX_CONCURRENT: '1', SESSION_IDLE_MINUTES: '5' })!.maxConcurrent, 1);
  assert.equal(parseSessionConfig({ ...base, SESSION_IDLE_MINUTES: '10080' })!.idleMinutes, 10080);
});

test('SESSION_PINNED_ACCOUNTS: a comma list of account ids, empty by default', () => {
  assert.deepEqual(parseSessionConfig(base)!.pinnedAccounts, []);
  assert.deepEqual(parseSessionConfig({ ...base, SESSION_PINNED_ACCOUNTS: ' ananya, brinda ,chetna, ' })!.pinnedAccounts, ['ananya', 'brinda', 'chetna']);
  assert.throws(() => parseSessionConfig({ ...base, SESSION_PINNED_ACCOUNTS: 'ananya;brinda' }), /SESSION_PINNED_ACCOUNTS/);
});

test('bad values stop boot', () => {
  assert.throws(() => parseSessionConfig({ ...base, SEF_GOLDEN_SNAPSHOT_ID: 'box-c0ab84' }), /snapshot id/);
  assert.throws(() => parseSessionConfig({ ...base, SESSION_MAX_CONCURRENT: '0' }), /SESSION_MAX_CONCURRENT/);
  assert.throws(() => parseSessionConfig({ ...base, SESSION_IDLE_MINUTES: '10081' }), /SESSION_IDLE_MINUTES/);
  assert.throws(() => parseSessionConfig({ ...base, SESSION_AUTO_SUSPEND_SECONDS: '60' }), /SESSION_AUTO_SUSPEND_SECONDS/);
  assert.throws(() => parseSessionConfig({ ...base, GATEWAY_TOKEN_SECRET: 'short' }), /32 bytes/);
  assert.throws(() => parseSessionConfig({ ...base, NODE_ENV: 'production' }), /GATEWAY_TOKEN_SECRET is required/);
});

test('ready = ok health with sync ready, or an engine that predates sync', () => {
  assert.equal(healthVerdict({ status: 200, body: { ok: true, engine: '0.2.0', uni: { reachable: false } } }), 'ready');
  assert.equal(healthVerdict({ status: 200, body: { ok: true, sync: { state: 'ready' } } }), 'ready');
  assert.equal(healthVerdict({ status: 200, body: { ok: true, sync: { state: 'restoring' } } }), 'waiting');
  assert.equal(healthVerdict({ status: 200, body: { ok: true, sync: { state: 'error' } } }), 'sync_error');
  assert.equal(healthVerdict({ status: 200, body: { ok: false } }), 'waiting');
  assert.equal(healthVerdict({ status: 502, body: null }), 'waiting');
  assert.equal(healthVerdict({ status: 200, body: 'Nothing is listening' }), 'waiting');
});

test('the flush answer is read from the last JSON line session-stop.sh prints', () => {
  assert.equal(flushErrorCode('{"ok":false,"error":"conflict"}\n'), 'conflict');
  assert.equal(flushErrorCode('some log\n{"ok":false,"error":"push_failed"}'), 'push_failed');
  assert.equal(flushErrorCode('{"ok":true,"pushed":3,"version":7}'), null);
  assert.equal(flushErrorCode('curl: (7) Failed to connect'), null);
  assert.equal(flushErrorCode('{"ok":false,"error":"<script>"}'), null);
});

test('workspace origins: the Instabox edge by default, https or loopback only, anything else stops boot', () => {
  assert.deepEqual(parseSessionConfig(base)!.workspaceOrigins, ['https://*.instabox.tech']);
  assert.deepEqual(parseWorkspaceOrigins('https://*.instabox.tech, http://127.0.0.1:3512'), ['https://*.instabox.tech', 'http://127.0.0.1:3512']);
  for (const bad of ['*', 'http://evil.test', 'https://*', "https://a.test 'unsafe-inline'", 'https://a.test/path', 'data:', 'https://*.*.test']) {
    assert.throws(() => parseWorkspaceOrigins(bad), /SESSION_WORKSPACE_ORIGINS/, bad);
  }
});

test('APP_PUBLIC_ORIGIN: one https origin (http on loopback), passed to the VM as ENGINE_ALLOWED_ORIGINS', () => {
  assert.equal(parseSessionConfig(base)!.appOrigin, undefined);
  assert.equal(parseSessionConfig({ ...base, APP_PUBLIC_ORIGIN: 'https://SEF.vercel.app/' })!.appOrigin, 'https://sef.vercel.app');
  assert.equal(parseAppOrigin('http://127.0.0.1:3540'), 'http://127.0.0.1:3540');
  for (const bad of ['*', 'http://sef.vercel.app', 'https://sef.vercel.app/app', 'https://a.test,https://b.test', 'https://*.vercel.app', 'https://localhost:3540 x']) {
    assert.throws(() => parseAppOrigin(bad), /APP_PUBLIC_ORIGIN/, bad);
  }

  const row = { url: 'https://4100-m1.instabox.tech', account_id: 'u_1', flush_token: 'f'.repeat(43), machine_id: 'm_1' };
  const without = sessionStartEnvs(parseSessionConfig(base)!, row);
  assert.equal(without.ENGINE_ALLOWED_ORIGINS, undefined, 'unset: the VM serves its own UI and allows only its own origin');
  assert.equal(without.ENGINE_PUBLIC_HOST, '4100-m1.instabox.tech');
  const withApp = sessionStartEnvs(parseSessionConfig({ ...base, APP_PUBLIC_ORIGIN: 'https://sef.vercel.app' })!, row);
  assert.equal(withApp.ENGINE_ALLOWED_ORIGINS, 'https://sef.vercel.app');
});

test('SEARXNG_URL: optional, a bare origin, passed to the VM only when set', () => {
  const row = { url: 'https://4100-m1.instabox.tech', account_id: 'u_1', flush_token: 'f'.repeat(43), machine_id: 'm_1' };
  assert.equal(sessionStartEnvs(parseSessionConfig(base)!, row).SEARXNG_URL, undefined);
  assert.equal(sessionStartEnvs(parseSessionConfig({ ...base, SEARXNG_URL: ' ' })!, row).SEARXNG_URL, undefined);
  assert.equal(sessionStartEnvs(parseSessionConfig({ ...base, SEARXNG_URL: 'https://sef-search.onrender.com/' })!, row).SEARXNG_URL, 'https://sef-search.onrender.com');
  assert.equal(parseSessionConfig({ ...base, SEARXNG_URL: 'http://127.0.0.1:8888' })!.searxngUrl, 'http://127.0.0.1:8888');
  for (const bad of ['http://search.example.com', 'https://search.example.com/search', 'https://search.example.com/?q=1', 'https://u:p@search.example.com', 'ftp://x.test', 'search.example.com']) {
    assert.throws(() => parseSessionConfig({ ...base, SEARXNG_URL: bad }), /SEARXNG_URL/, bad);
  }
});
