import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rank, recentlyAsked } from './score';
import type { Seed } from './seeds';
import { NOW } from './testing/fixtures';

const seed = (key: string, slots: Record<string, string>, urgency = 0.5): Seed => ({ key, kind: 'weak_concept', slots, refs: [], why: 'w', urgency, at: NOW.getTime(), expiresAt: NOW.getTime() + 1 });

test('a topic named in a recent turn is pushed below fresh ones', () => {
  const entropy = seed('weak_concept:entropy', { concept: 'Entropy' }, 0.6);
  const momentum = seed('weak_concept:momentum', { concept: 'Momentum' }, 0.5);
  assert.deepEqual(rank([entropy, momentum], NOW, []).map((s) => s.key), ['weak_concept:entropy', 'weak_concept:momentum']);
  assert.deepEqual(rank([entropy, momentum], NOW, ['can you explain ENTROPY again?']).map((s) => s.key), ['weak_concept:momentum', 'weak_concept:entropy']);
});

test('weekday slots never count as a topic match', () => {
  assert.equal(recentlyAsked(seed('d', { title: 'Essay', day: 'Friday' }), ['see you friday']), false);
});

test('equal scores fall back to key order, so ranking is deterministic', () => {
  const a = seed('b', { concept: 'Bbb' });
  const b = seed('a', { concept: 'Aaa' });
  assert.deepEqual(rank([a, b], NOW, []).map((s) => s.key), ['a', 'b']);
});
