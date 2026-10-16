import assert from 'node:assert/strict';
import test from 'node:test';
import type { Verification } from '@sef/shared';
import { providerDisclosure, segmentSummary } from './verification-summary';

const base = (over: Partial<Verification> = {}): Verification => ({ model: 'gemma4:e4b', provider: 'Ollama', sources: [], checks: [], toolCalls: [], ...over });

test('the segment summary names each kind plainly and counts what was withheld', () => {
  const summary = segmentSummary(
    base({
      withheld: 2,
      segments: [
        { kind: 'fact', text: 'a', support: 'supported' },
        { kind: 'fact', text: 'b', support: 'supported' },
        { kind: 'belief', text: 'c', support: 'supported' },
        { kind: 'uncertainty', text: 'd', support: 'not_required' },
        { kind: 'question', text: 'e', support: 'not_required' },
      ],
    }),
  );
  assert.equal(summary, '2 facts · 1 student beliefs · 1 uncertainty · 1 questions · 2 withheld');
});

test('a verification with no segment map and nothing withheld shows no summary', () => {
  assert.equal(segmentSummary(base()), null);
});

test('withheld statements are reported even when no segments survived', () => {
  assert.equal(segmentSummary(base({ withheld: 3 })), '3 withheld');
});

test('provider kind is disclosed honestly: local device vs hosted', () => {
  assert.equal(providerDisclosure(base({ providerKind: 'ollama' })), 'on this device');
  assert.match(providerDisclosure(base({ providerKind: 'anthropic' }))!, /left this device/);
  assert.match(providerDisclosure(base({ providerKind: 'openai-compatible' }))!, /hosted/);
  assert.equal(providerDisclosure(base()), null);
});
