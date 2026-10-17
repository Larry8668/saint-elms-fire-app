import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ProviderConfig } from '@sef/shared';

// A hosted session: the gateway comes from the environment the session start script wrote.
process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-gateway-settings-'));
process.env.MODEL_GATEWAY_URL = 'https://gateway.example.test/v1/';
process.env.MODEL_GATEWAY_TOKEN = 'session-token-123';

const { config, parseModelGateway, profilePaths } = await import('../config');
const { ProfileSettingsStore, SettingsStore, withGateway } = await import('./store');

test('every role defaults to the gateway, with the token only in what the engine reads', async () => {
  const device = new SettingsStore();
  const settings = await device.get();
  for (const role of Object.values(settings.roles)) assert.equal(role.provider, 'uni');
  const uni = settings.providers.find((p) => p.id === 'uni');
  assert.deepEqual([uni?.kind, uni?.baseUrl, uni?.apiKey], ['openai-compatible', 'https://gateway.example.test/v1', 'session-token-123']);

  await device.update({ searxngUrl: 'http://localhost:8888' });
  const alice = new ProfileSettingsStore(device, profilePaths('alice').privateSettings);
  await alice.update({ thinking: false });
  assert.equal((await alice.get()).providers.find((p) => p.id === 'uni')?.apiKey, 'session-token-123');
  for (const file of [config.paths.settings, profilePaths('alice').privateSettings]) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /session-token-123/, `${file} holds no token`);
  }
});

test('a stored provider or an on-box role from an older session is re-pointed at the current gateway', () => {
  const stale = { providers: [{ id: 'uni', kind: 'ollama' as const, label: 'University model', baseUrl: 'https://old.example.test', apiKey: 'old' }] };
  const fresh = withGateway(stale, { url: 'https://new.example.test/v1', token: 'new' }).providers[0];
  assert.deepEqual([fresh?.kind, fresh?.baseUrl, fresh?.apiKey], ['openai-compatible', 'https://new.example.test/v1', 'new']);
  assert.equal(withGateway(stale, null), stale, 'no gateway leaves settings untouched');
  type Roles = NonNullable<Parameters<typeof withGateway>[0]['roles']>;
  const roles = { tutor: { provider: 'ollama', model: 'gemma4:e2b' }, brain: { provider: 'mine', model: 'x' } } as unknown as Roles;
  const restored = withGateway({ providers: [] as ProviderConfig[], roles }, { url: 'https://gw.test' });
  assert.deepEqual([restored.roles?.tutor?.provider, restored.roles?.brain?.provider], ['uni', 'mine']);
  assert.deepEqual(restored.providers.map((p) => [p.id, p.baseUrl]), [['uni', 'https://gw.test']], 'a missing gateway provider is added');
});

test('the gateway URL is parsed fail-closed', () => {
  assert.equal(parseModelGateway({}), null);
  assert.deepEqual(parseModelGateway({ MODEL_GATEWAY_URL: 'http://gw:8080/' }), { url: 'http://gw:8080' });
  assert.throws(() => parseModelGateway({ MODEL_GATEWAY_URL: 'gw.example.test' }), /http\(s\) URL/);
});
