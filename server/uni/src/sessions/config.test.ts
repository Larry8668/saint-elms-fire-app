import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSessionConfig } from './config';
import { healthVerdict } from './orchestrator';

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
});

test('bad values stop boot', () => {
  assert.throws(() => parseSessionConfig({ ...base, SEF_GOLDEN_SNAPSHOT_ID: 'box-c0ab84' }), /snapshot id/);
  assert.throws(() => parseSessionConfig({ ...base, SESSION_MAX_CONCURRENT: '0' }), /SESSION_MAX_CONCURRENT/);
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
