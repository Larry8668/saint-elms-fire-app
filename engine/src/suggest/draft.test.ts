import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptDraft, draftPrompt, MAX_DRAFT_CHARS } from './draft';
import type { Seed } from './seeds';
import { NOW } from './testing/fixtures';

const seed: Seed = { key: 'synthesis_link:s', kind: 'synthesis_link', slots: { a: 'Entropy', b: 'Momentum' }, refs: [], why: 'w', urgency: 0.3, at: NOW.getTime(), expiresAt: NOW.getTime() + 1 };
const universe = new Set(['Entropy', 'Momentum', 'Heat engines', 'Lab report']);

test('a draft that keeps every seed entity and adds none is accepted', () => {
  assert.equal(acceptDraft('So how would entropy shift if momentum stopped holding?', seed, universe), true);
});

test('dropping a seed entity or introducing another known one falls back to the template', () => {
  assert.equal(acceptDraft('How would entropy shift here?', seed, universe), false, 'lost Momentum');
  assert.equal(acceptDraft('How do Entropy and Momentum relate to heat engines?', seed, universe), false, 'invented a link to Heat engines');
  assert.equal(acceptDraft('Entropy, Momentum and your Lab report — discuss.', seed, universe), false, 'leaked a Friend-only entity');
});

test('empty, missing and oversized drafts are refused', () => {
  assert.equal(acceptDraft(undefined, seed, universe), false);
  assert.equal(acceptDraft('   ', seed, universe), false);
  assert.equal(acceptDraft(`Entropy Momentum ${'x'.repeat(MAX_DRAFT_CHARS)}`, seed, universe), false);
});

test('the drafting prompt carries only the template questions', () => {
  assert.equal(draftPrompt(['One?', 'Two?']), '1. One?\n2. Two?');
});
