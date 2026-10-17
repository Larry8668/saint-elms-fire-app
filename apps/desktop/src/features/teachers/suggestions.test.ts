import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, type SuggestionsResponse } from '@sef/shared';
import { railState, readHidden, whyText, writeHidden } from './suggestions';

const NOW = Date.parse('2026-10-17T10:00:00Z');
const question = (id: string, expiresAt = '2026-10-18T10:00:00.000Z') => ({
  id,
  teacher: 'guide' as const,
  text: `Question ${id}`,
  why: 'An open question in your wiki',
  seedRefs: [`page:${id}`],
  generatedAt: '2026-10-17T09:00:00.000Z',
  expiresAt,
});
const response = (mode: SuggestionsResponse['mode'], questions = [question('a')]): SuggestionsResponse => ({ schemaVersion: CONTRACT_VERSION, teacher: 'guide', questions, generatedAt: '2026-10-17T09:00:00.000Z', mode });

test('rail states: hidden wins, then loading, then empty or ready', () => {
  assert.deepEqual(railState({ pending: true, hidden: true }), { kind: 'hidden' });
  assert.deepEqual(railState({ pending: true, hidden: false }), { kind: 'loading' });
  assert.deepEqual(railState({ pending: false, hidden: false }), { kind: 'empty' }, 'an error leaves no data → nothing rendered');
  const ready = railState({ pending: false, hidden: false, data: response('templates'), now: NOW });
  assert.equal(ready.kind, 'ready');
});

test('expired chips are dropped client-side too', () => {
  const state = railState({ pending: false, hidden: false, data: response('templates', [question('old', '2026-10-17T09:59:00.000Z'), question('live')]), now: NOW });
  assert.ok(state.kind === 'ready' && state.questions.map((q) => q.id).join() === 'live');
});

test('model wording is disclosed in the why text', () => {
  const state = railState({ pending: false, hidden: false, data: response('hybrid'), now: NOW });
  assert.ok(state.kind === 'ready' && state.worded);
  assert.equal(whyText(question('a'), false), 'Because: An open question in your wiki.');
  assert.match(whyText(question('a'), true), /polished by your model/);
});

test('the hide choice persists and tolerates a refusing store', () => {
  const map = new Map<string, string>();
  const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
  assert.equal(readHidden(store), false);
  writeHidden(store, true);
  assert.equal(readHidden(store), true);
  writeHidden(store, false);
  assert.equal(readHidden(store), false);
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {},
  };
  assert.equal(readHidden(broken), false);
  assert.doesNotThrow(() => writeHidden(broken, true));
  assert.equal(readHidden(undefined), false);
});
