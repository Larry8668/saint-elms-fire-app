import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { EngineSettings, ProviderConfig } from '@sef/shared';
import type { SettingsReader } from '../settings/store';
import { cosine, embedKeyId, mergeHits, SEMANTIC_FLOOR } from './hybrid';
import { EmbeddingIndex } from './index';
import { EmbeddingService } from './service';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-embed-'));

const provider: ProviderConfig = { id: 'p', kind: 'ollama', label: 'Test model' };

const settingsFor = (roles: Record<string, { provider: string; model: string }>): SettingsReader => ({
  get: async () =>
    ({ uniServerUrl: '', searxngUrl: '', thinking: false, providers: [provider], roles }) as EngineSettings,
});

const withEmbed = settingsFor({ embed: { provider: 'p', model: 'emb' } });
const withoutEmbed = settingsFor({ tutor: { provider: 'p', model: 'm' } });

/** A deterministic embed: 'alpha' texts point one way, everything else the other. */
const fakeEmbed = (calls: string[][]) => async (_provider: ProviderConfig, _model: string, texts: string[]) => {
  calls.push(texts);
  return texts.map((text) => (text.includes('alpha') ? [1, 0] : [0, 1]));
};

const makeService = async (options: { embed?: (provider: ProviderConfig, model: string, texts: string[]) => Promise<number[][]>; settings?: SettingsReader; index?: EmbeddingIndex } = {}) => {
  const index = options.index ?? new EmbeddingIndex(await mkdtemp(path.join(tmpdir(), 'sef-embed-idx-')));
  return { index, service: new EmbeddingService({ index, settings: options.settings ?? withEmbed, ...(options.embed ? { embed: options.embed } : {}) }) };
};

test('cosine: same direction is 1, orthogonal is 0, opposite is negative', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(cosine([1, 0], [-1, 0]) < 0);
  assert.equal(cosine([], [1]), 0, 'an empty vector never scores');
});

test('mergeHits union-merges the lanes and labels how each hit was found', () => {
  const merged = mergeHits(new Map([['a', 10], ['b', 5]]), new Map([['a@rev-1', 0.9], ['c@rev-1', 0.8]]));
  assert.deepEqual(
    merged.map((hit) => [hit.id, hit.match]),
    [
      ['a', 'both'],
      ['c', 'semantic'],
      ['b', 'keyword'],
    ],
    'a page found by both lanes outranks either lane alone',
  );
  assert.equal(embedKeyId('a@rev-1'), 'a', 'the entity id survives the content key');

  const keywordOnly = mergeHits(new Map([['a', 10], ['b', 5]]), null);
  assert.deepEqual(
    keywordOnly.map((hit) => [hit.id, hit.match]),
    [
      ['a', 'keyword'],
      ['b', 'keyword'],
    ],
  );
});

test('the index fills lazily, persists per scope, and a revision bump re-embeds only what changed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-embed-idx-'));
  const calls: string[][] = [];
  const { service } = await makeService({ embed: fakeEmbed(calls), index: new EmbeddingIndex(dir) });
  const corpus = new Map([
    ['page-a@rev-1', 'alpha text'],
    ['page-b@rev-1', 'beta text'],
  ]);

  const scores = await service.search('pages', corpus, 'tell me about alpha');
  assert.ok(scores, 'the lane ran');
  assert.ok(scores.get('page-a@rev-1')! >= SEMANTIC_FLOOR);
  assert.equal(scores.has('page-b@rev-1'), false, 'orthogonal content stays under the floor');
  assert.equal(calls.length, 2, 'one corpus batch plus one query embed');

  const stored = JSON.parse(await readFile(path.join(dir, 'pages.json'), 'utf8')) as { model: string; entries: Record<string, number[]> };
  assert.equal(stored.model, 'emb');
  assert.deepEqual(Object.keys(stored.entries).sort(), ['page-a@rev-1', 'page-b@rev-1'], 'vectors are content-addressed and persisted');

  // A second search reuses the stored vectors — only the query is embedded again.
  await service.search('pages', corpus, 'alpha again');
  assert.equal(calls.length, 3);

  // A revision bump means new keys: the old vector is evicted, the page is re-embedded.
  const bumped = new Map([
    ['page-a@rev-2', 'alpha text'],
    ['page-b@rev-1', 'beta text'],
  ]);
  await service.search('pages', bumped, 'alpha once more');
  const after = JSON.parse(await readFile(path.join(dir, 'pages.json'), 'utf8')) as { entries: Record<string, number[]> };
  assert.deepEqual(Object.keys(after.entries).sort(), ['page-a@rev-2', 'page-b@rev-1']);
  assert.equal(calls.at(-2)!.length, 1, 'only the changed key went back to the model');

  // A fresh service over the same directory sees the persisted index — rebuild costs nothing.
  const { service: reopened } = await makeService({ embed: fakeEmbed(calls), index: new EmbeddingIndex(dir) });
  await reopened.search('pages', bumped, 'alpha persists');
  assert.equal(calls.at(-1)!.length, 1, 'the reopened index only embeds the query');
});

test('an unreachable model reports the lane down, and a missing role reports it unconfigured', async () => {
  const { service: down } = await makeService({ embed: async () => Promise.reject(new Error('connect ECONNREFUSED')) });
  const corpus = new Map([['page-a@rev-1', 'alpha text']]);
  assert.equal(await down.search('pages', corpus, 'alpha'), null, 'the caller falls back to keyword-only');

  const calls: string[][] = [];
  const { service: unconfigured } = await makeService({ settings: withoutEmbed, embed: fakeEmbed(calls) });
  assert.equal(await unconfigured.search('pages', corpus, 'alpha'), null);
  assert.equal(calls.length, 0, 'no embed call is made when no embed role is configured');
});

test('pairs surfaces only the near-duplicates above the floor', async () => {
  const calls: string[][] = [];
  const { service } = await makeService({ embed: fakeEmbed(calls) });
  const corpus = new Map([
    ['page-a@rev-1', 'alpha text'],
    ['page-b@rev-1', 'another alpha draft'],
    ['page-c@rev-1', 'beta text'],
  ]);
  const pairs = await service.pairs('pages', corpus);
  assert.ok(pairs);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0]!.a, pairs[0]!.b].sort(), ['page-a@rev-1', 'page-b@rev-1']);
  assert.ok(pairs[0]!.score >= 0.75);
});
