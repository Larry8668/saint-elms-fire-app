import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, parseModelAliases } from './config';

const MODELS = ['gemma4:e4b', 'gemma4:e2b', 'embeddinggemma'];

test('model aliases parse requested=served pairs and normalize :latest', () => {
  assert.deepEqual(parseModelAliases(undefined, MODELS), {});
  assert.deepEqual(parseModelAliases(' gemma4:e2b = gemma4:e4b , ', MODELS), { 'gemma4:e2b': 'gemma4:e4b' });
  assert.deepEqual(parseModelAliases('gemma4:e2b:latest=gemma4:e4b:latest', MODELS), { 'gemma4:e2b': 'gemma4:e4b' });
});

test('model aliases refuse names outside the allowlist, self-maps, chains and junk', () => {
  assert.throws(() => parseModelAliases('gemma4:e2b=secret-model', MODELS), /outside GATEWAY_MODELS/);
  assert.throws(() => parseModelAliases('qwen=gemma4:e4b', MODELS), /outside GATEWAY_MODELS/);
  assert.throws(() => parseModelAliases('gemma4:e4b=gemma4:e4b', MODELS), /to itself/);
  assert.throws(() => parseModelAliases('gemma4:e2b=gemma4:e4b,gemma4:e4b=embeddinggemma', MODELS), /chain/);
  assert.throws(() => parseModelAliases('embeddinggemma=gemma4:e2b,gemma4:e2b=gemma4:e4b', MODELS), /chain/);
  assert.throws(() => parseModelAliases('gemma4:e2b', MODELS), /requested=served/);
  assert.throws(() => parseModelAliases('a=b=c', MODELS), /requested=served/);
});

test('loadConfig wires GATEWAY_MODEL_ALIASES against GATEWAY_MODELS', () => {
  const env = { GATEWAY_TOKEN_SECRET: 'x'.repeat(32), GATEWAY_MODEL_ALIASES: 'gemma4:e2b=gemma4:e4b' };
  assert.deepEqual(loadConfig(env).modelAliases, { 'gemma4:e2b': 'gemma4:e4b' });
  assert.throws(() => loadConfig({ ...env, GATEWAY_MODELS: 'gemma4:e2b' }), /outside GATEWAY_MODELS/);
  assert.deepEqual(loadConfig({ GATEWAY_TOKEN_SECRET: 'x'.repeat(32) }).modelAliases, {});
});
