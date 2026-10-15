import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-private-settings-'));

const { profilePaths } = await import('../config');
const { ProfileSettingsStore, SettingsStore } = await import('./store');

const provider = (id: string, apiKey?: string) => ({
  id,
  kind: 'openai-compatible' as const,
  label: id,
  baseUrl: 'https://models.example.test/v1',
  apiKey,
});

test('provider credentials are stored per profile and never copied from device settings', async () => {
  const device = new SettingsStore();
  await device.update({ providers: [provider('device-provider', 'device-secret')] });
  const alice = new ProfileSettingsStore(device, profilePaths('alice').privateSettings);
  const bob = new ProfileSettingsStore(device, profilePaths('bob').privateSettings);

  assert.equal((await alice.get()).providers.find((p) => p.id === 'device-provider'), undefined);
  await alice.update({ providers: [provider('alice-provider', 'alice-secret')] });

  assert.equal((await alice.get()).providers.find((p) => p.id === 'alice-provider')?.apiKey, 'alice-secret');
  assert.equal((await bob.get()).providers.find((p) => p.id === 'alice-provider'), undefined);
  assert.equal((await device.get()).providers.find((p) => p.id === 'device-provider')?.apiKey, 'device-secret');

  const persisted = await readFile(profilePaths('alice').privateSettings, 'utf8');
  assert.match(persisted, /alice-secret/);
  assert.doesNotMatch(persisted, /device-secret/);
});

test('profile settings share device endpoints while keeping model choices local', async () => {
  const device = new SettingsStore();
  const alice = new ProfileSettingsStore(device, profilePaths('alice').privateSettings);
  const bob = new ProfileSettingsStore(device, profilePaths('bob').privateSettings);

  await alice.update({ uniServerUrl: 'https://uni.example.test', thinking: false });

  assert.equal((await bob.get()).uniServerUrl, 'https://uni.example.test');
  assert.equal((await bob.get()).thinking, true);
  assert.equal((await alice.get()).thinking, false);
});
