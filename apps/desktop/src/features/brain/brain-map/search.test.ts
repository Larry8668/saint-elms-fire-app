import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageRecordSummary, WikiGraph } from '@sef/shared';
import { buildSearchIndex, searchPages } from './search';

const rec = (id: string, title: string, summary = ''): PageRecordSummary => ({ id, kind: 'concept', title, summary, updatedAt: '2025-01-01T00:00:00.000Z', revision: 'rev-1', origin: 'student' });
const wiki: WikiGraph = {
  schemaVersion: 1 as never,
  nodes: [{ id: 'damping', kind: 'concept', title: 'Damping', summary: '', updatedAt: null, claims: 1, claimTexts: ['Friction removes energy from the oscillator'], sourceIds: [], courseIds: [] }],
  edges: [],
};

test('every term must match; title hits rank first; claims are searchable', () => {
  const index = buildSearchIndex([rec('energy', 'Energy'), rec('damping', 'Damping', 'Oscillators losing amplitude'), rec('work', 'Work', 'Energy transferred by a force')], wiki);
  assert.equal(searchPages(index, '   '), null, 'a blank query is no search');
  assert.deepEqual(searchPages(index, 'energy')!.ids, ['energy', 'damping', 'work'], 'the title hit leads; body and claim hits follow');
  assert.deepEqual(searchPages(index, 'friction')!.ids, ['damping'], 'claim text is reached');
  assert.deepEqual(searchPages(index, 'energy force')!.ids, ['work']);
  assert.equal(searchPages(index, 'ÉNERGY')!.set.has('energy'), true, 'case and accents fold');
  assert.deepEqual(searchPages(index, 'nerg')!.ids, [], 'terms match at word starts, not mid-word');
  assert.deepEqual(searchPages(index, 'osc')!.ids, ['damping'], 'a prefix is enough');
  assert.equal(searchPages(index, 'nothing-like-this')!.ids.length, 0);
});
