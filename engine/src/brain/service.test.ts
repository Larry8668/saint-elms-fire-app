import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { EngineSettings } from '@sef/shared';
import type { ContentStore } from '../content/store';
import type { SettingsReader } from '../settings/store';
import { BrainService } from './service';
import { SourceIngestor, SourceRejection } from './sources/ingest';
import { PROFILE, tempRoot, vault } from './testing/fixtures';
import { BrainVault } from './vault';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-brain-service-'));

const settings: SettingsReader = {
  get: async () =>
    ({
      uniServerUrl: 'https://uni.example.test',
      searxngUrl: '',
      thinking: false,
      providers: [{ id: 'p', kind: 'ollama', label: 'Test model' }],
      roles: { tutor: { provider: 'p', model: 'm' }, brain: { provider: 'p', model: 'm' }, vision: { provider: 'p', model: 'm' } },
    }) as EngineSettings,
};

const content = { academicLessons: async () => [], installed: async () => ({}) } as unknown as ContentStore;
const identity = async () => PROFILE;

const harness = async (prefix: string) => {
  const store = await vault(prefix);
  const sources = new SourceIngestor(store, identity);
  const vaultView = new BrainVault(store.root);
  await vaultView.init();
  const brain = new BrainService(content, vaultView, settings, await tempRoot(`${prefix}-quizzes`), { wiki: store, sources, identity });
  return { store, sources, brain };
};

/** A PNG header carrying the given dimensions. */
const png = (width: number, height: number): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]);
};

test('an image over the pixel limit is refused before the vision model is asked', async () => {
  const { store, sources, brain } = await harness('read-oversized');
  const { source } = await sources.ingest({ kind: 'image', title: 'Whiteboard', mediaType: 'image/png', bytes: png(9000, 9000) });
  const before = (await store.readSource(source.id))?.extractions ?? [];
  const error = await brain.readImageSource(source.id).catch((e: unknown) => e);
  assert.ok(error instanceof SourceRejection, 'a typed refusal, not a model error');
  assert.equal(error.code, 'image_too_large');
  assert.equal(error.status, 413);
  const after = (await store.readSource(source.id))?.extractions ?? [];
  assert.deepEqual(after, before, 'no new pass was recorded — the reader never ran');
});

test('an image whose header cannot be read at all is refused the same way', async () => {
  const { sources, brain } = await harness('read-unreadable');
  const { source } = await sources.ingest({ kind: 'image', title: 'Torn photo', mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  const error = await brain.readImageSource(source.id).catch((e: unknown) => e);
  assert.ok(error instanceof SourceRejection);
  assert.equal(error.code, 'image_too_large');
  assert.match(error.message, /no readable dimensions/);
});
