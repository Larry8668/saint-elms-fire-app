import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceCapability, EngineSettings } from '@sef/shared';
import { applySuggestions, describeDevice, dismissCard, DISMISS_KEY, isCardDismissed, pendingSuggestions, suggestionFor } from './recommendation';

const bigMachine: DeviceCapability = { ramGb: 32, gpu: 'Apple M2 Max', suggested: { tutor: 'gemma4:e4b', brain: 'gemma4:26b', vision: 'gemma4:e4b' } };

const settings = (overrides: Partial<EngineSettings['roles']> = {}): Pick<EngineSettings, 'providers' | 'roles'> => ({
  providers: [
    { id: 'ollama', kind: 'ollama', label: 'Ollama' },
    { id: 'uni', kind: 'openai-compatible', label: 'University' },
  ],
  roles: {
    tutor: { provider: 'ollama', model: 'gemma4:e4b' },
    brain: { provider: 'ollama', model: 'gemma4:e4b' },
    vision: { provider: 'ollama', model: 'gemma4:e4b' },
    embed: { provider: 'ollama', model: 'embeddinggemma' },
    safety: { provider: 'ollama', model: 'shieldgemma:2b' },
    ...overrides,
  },
});

const memoryStore = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

test('a fresh profile on a big machine is offered 26b for the brain only', () => {
  assert.deepEqual(pendingSuggestions(bigMachine, settings()), [{ role: 'brain', current: 'gemma4:e4b', suggested: 'gemma4:26b' }]);
});

test('roles on a non-Ollama provider, and untiered roles, get no suggestion', () => {
  const s = settings({ brain: { provider: 'uni', model: 'uni-large' } });
  assert.equal(suggestionFor('brain', bigMachine, s), undefined);
  assert.deepEqual(pendingSuggestions(bigMachine, s), []);
  assert.equal(suggestionFor('embed', bigMachine, s), undefined);
  assert.equal(suggestionFor('tutor', undefined, s), undefined);
});

test('a :latest alias counts as already matching', () => {
  assert.deepEqual(pendingSuggestions(bigMachine, settings({ brain: { provider: 'ollama', model: 'gemma4:26b:latest' } })), []);
});

test('applying writes only the suggested roles into the form', () => {
  const before = settings().roles;
  const after = applySuggestions(before, pendingSuggestions(bigMachine, settings()));
  assert.equal(after.brain.model, 'gemma4:26b');
  assert.equal(after.brain.provider, 'ollama');
  assert.equal(after.tutor, before.tutor);
  assert.equal(before.brain.model, 'gemma4:e4b', 'the input is not mutated');
});

test('dismissing hides the card for this suggestion, and a new tier brings it back', () => {
  const store = memoryStore();
  assert.equal(isCardDismissed(store, bigMachine), false);
  dismissCard(store, bigMachine);
  assert.equal(isCardDismissed(store, bigMachine), true);
  assert.equal(store.data.get(DISMISS_KEY), 'gemma4:e4b|gemma4:26b|gemma4:e4b');

  const upgraded: DeviceCapability = { ...bigMachine, ramGb: 64, suggested: { tutor: 'gemma4:26b', brain: 'gemma4:31b', vision: 'gemma4:e4b' } };
  assert.equal(isCardDismissed(store, upgraded), false);
});

test('unavailable storage never breaks the card', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.equal(isCardDismissed(broken, bigMachine), false);
  assert.doesNotThrow(() => dismissCard(broken, bigMachine));
  assert.equal(isCardDismissed(undefined, bigMachine), false);
});

test('the device line names what was detected and admits what was not', () => {
  assert.equal(describeDevice(bigMachine), '32 GB memory · Apple M2 Max');
  assert.equal(describeDevice({ ...bigMachine, ramGb: null, gpu: undefined }), 'Memory unknown');
});
