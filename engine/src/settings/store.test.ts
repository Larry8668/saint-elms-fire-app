import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-private-settings-'));

const { config, profilePaths } = await import('../config');
const { writeJson } = await import('../lib/fs');
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

test('a settings file from before the embed role existed gains it on read, and partial role updates keep the rest', async () => {
  // Device level: the stored file lacks the role entirely.
  const deviceFile = path.join(await mkdtemp(path.join(tmpdir(), 'sef-device-')), 'settings.json');
  await writeJson(deviceFile, {
    uniServerUrl: 'https://uni.example.test',
    searxngUrl: '',
    thinking: true,
    providers: [{ id: 'ollama', kind: 'ollama', label: 'Local', baseUrl: 'http://localhost:11434' }],
    roles: { tutor: { provider: 'ollama', model: 'gemma4:e4b' }, brain: { provider: 'ollama', model: 'gemma4:e4b' }, vision: { provider: 'ollama', model: 'gemma4:e4b' } },
  });
  const device = new SettingsStore(deviceFile);
  const deviceSettings = await device.get();
  assert.equal(deviceSettings.roles.embed.provider, 'ollama');
  assert.equal(deviceSettings.roles.embed.model, config.defaults.embedModel);

  // Profile level: same backfill, and a partial roles patch does not drop the backfilled role.
  const carol = new ProfileSettingsStore(device, profilePaths('carol').privateSettings);
  await carol.update({ roles: { tutor: { provider: 'x', model: 'custom-tutor' } } });
  const after = await carol.get();
  assert.equal(after.roles.tutor.model, 'custom-tutor');
  assert.equal(after.roles.embed.model, config.defaults.embedModel, 'an update naming only one role keeps the others');
});
