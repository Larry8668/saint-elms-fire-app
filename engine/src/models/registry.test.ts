import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ollamaOptions } from './registry';

test('ollamaOptions falls back to the shipped defaults when unset or blank', () => {
  assert.deepEqual(ollamaOptions({}), { num_ctx: 12288, num_predict: 1200 });
  assert.deepEqual(ollamaOptions({ OLLAMA_NUM_CTX: '   ', OLLAMA_NUM_PREDICT: ' ' }), { num_ctx: 12288, num_predict: 1200 });
});

test('ollamaOptions accepts integer overrides', () => {
  assert.deepEqual(ollamaOptions({ OLLAMA_NUM_CTX: '8192', OLLAMA_NUM_PREDICT: '600' }), { num_ctx: 8192, num_predict: 600 });
  assert.deepEqual(ollamaOptions({ OLLAMA_NUM_CTX: ' 16384 ' }), { num_ctx: 16384, num_predict: 1200 });
});

test('ollamaOptions refuses malformed values with a named error instead of NaN', () => {
  for (const raw of ['abc', '4.5', '-2', '1e3', 'NaN', '0x10', '1200ms', '+5']) {
    assert.throws(
      () => ollamaOptions({ OLLAMA_NUM_CTX: raw }),
      (error: unknown) => error instanceof Error && error.message.startsWith('OLLAMA_NUM_CTX must be an integer'),
    );
    assert.throws(
      () => ollamaOptions({ OLLAMA_NUM_PREDICT: raw }),
      (error: unknown) => error instanceof Error && error.message.startsWith('OLLAMA_NUM_PREDICT must be an integer'),
    );
  }
  assert.throws(() => ollamaOptions({ OLLAMA_NUM_CTX: '0' }), /between 1/);
});
