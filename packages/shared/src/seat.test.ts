import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EngineLoginRequestSchema, LoginRequestSchema } from './index';

test('the engine login body is the uni login body plus an optional, sanitised device label', () => {
  const plain = EngineLoginRequestSchema.parse({ email: ' Ana@Example.Test ', password: 'pw' });
  assert.deepEqual(plain, { email: 'ana@example.test', password: 'pw' });
  const labelled = EngineLoginRequestSchema.parse({ email: 'a@example.test', password: 'pw', deviceLabel: '  Library PC\u0007\n ' });
  assert.equal(labelled.deviceLabel, 'Library PC');
  assert.equal(EngineLoginRequestSchema.safeParse({ email: 'a@example.test', password: 'pw', deviceLabel: 'x'.repeat(81) }).success, false);
  // The uni's own schema is untouched: an extra field is simply stripped there.
  assert.deepEqual(LoginRequestSchema.parse({ email: 'a@example.test', password: 'pw', deviceLabel: 'x' }), { email: 'a@example.test', password: 'pw' });
});
