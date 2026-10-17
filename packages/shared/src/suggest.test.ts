import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION } from './contracts';
import { MAX_SUGGESTIONS, SuggestionsResponseSchema } from './suggest';

const question = (id: string) => ({
  id,
  teacher: 'guide' as const,
  text: 'Quiz me on Entropy.',
  why: 'Your evidence on this concept is still shaky',
  seedRefs: ['page:entropy'],
  generatedAt: '2026-10-17T10:00:00.000Z',
  expiresAt: '2026-10-18T10:00:00.000Z',
});
const response = (count: number) => ({ schemaVersion: CONTRACT_VERSION, teacher: 'guide', questions: Array.from({ length: count }, (_, i) => question(`sq_${i}`)), generatedAt: '2026-10-17T10:00:00.000Z', mode: 'templates' });

test('suggestions round-trip and stay capped at five', () => {
  assert.deepEqual(SuggestionsResponseSchema.parse(response(MAX_SUGGESTIONS)), response(MAX_SUGGESTIONS));
  assert.equal(SuggestionsResponseSchema.safeParse(response(MAX_SUGGESTIONS + 1)).success, false);
});

test('unknown fields, teachers and modes are refused', () => {
  assert.equal(SuggestionsResponseSchema.safeParse({ ...response(1), extra: true }).success, false);
  assert.equal(SuggestionsResponseSchema.safeParse({ ...response(1), teacher: 'oracle' }).success, false);
  assert.equal(SuggestionsResponseSchema.safeParse({ ...response(1), mode: 'autonomous' }).success, false);
});
