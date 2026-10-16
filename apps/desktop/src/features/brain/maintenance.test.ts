import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MaintenanceFinding } from '@sef/shared';
import { actionLabel, findingTone, isActionable, needsCatalogueRepair, semanticStatusLine, sortFindings, FINDING_LABEL } from './maintenance';

const finding = (over: Partial<MaintenanceFinding> = {}): MaintenanceFinding => ({
  id: 'f_test',
  origin: 'deterministic',
  kind: 'orphan',
  pageIds: ['page-a'],
  title: 'A finding',
  detail: 'Something needs attention.',
  evidence: [],
  action: { kind: 'suggestion' },
  revisions: { 'page-a': 'rev-1' },
  ...over,
});

test('every finding kind has a student-readable label', () => {
  for (const kind of Object.keys(FINDING_LABEL) as (keyof typeof FINDING_LABEL)[]) {
    assert.ok(FINDING_LABEL[kind].length > 3, `${kind} labelled`);
  }
  assert.equal(new Set(Object.keys(FINDING_LABEL)).size, 14);
});

test('only repairable findings are actionable; suggestions and catalogue work are not filed', () => {
  assert.equal(isActionable(finding({ action: { kind: 'repair_page', pageId: 'p', repair: 'dead_links' } })), true);
  assert.equal(isActionable(finding({ action: { kind: 'add_link', fromPageId: 'a', toPageId: 'b', linkType: 'related_to', why: 'x' } })), true);
  assert.equal(isActionable(finding({ action: { kind: 'suggestion' } })), false);
  assert.equal(isActionable(finding({ action: { kind: 'rebuild_catalogue' } })), false);
  assert.equal(needsCatalogueRepair(finding({ action: { kind: 'rebuild_catalogue' } })), true);
});

test('the action label names the fix so the checkbox is honest', () => {
  assert.equal(actionLabel(finding({ action: { kind: 'suggestion' } })), null);
  assert.equal(actionLabel(finding({ action: { kind: 'repair_page', pageId: 'p', repair: 'dispute_claim' } })), 'mark both claims disputed');
  assert.equal(actionLabel(finding({ action: { kind: 'add_link', fromPageId: 'a', toPageId: 'b', linkType: 'related_to', why: 'x' } })), 'link to b');
});

test('semantic suggestions sort after deterministic findings and wear the gold badge', () => {
  const semantic = finding({ id: 'f_s', origin: 'semantic', kind: 'contradiction' });
  const structural = finding({ id: 'f_d', kind: 'dead_link' });
  assert.deepEqual(sortFindings([semantic, structural]).map((f) => f.id), ['f_d', 'f_s']);
  assert.equal(findingTone(semantic), 'gold');
  assert.equal(findingTone(structural), 'ember');
});

test('the semantic status line is honest about never having run and about failure', () => {
  assert.match(semanticStatusLine({ state: 'never_run', lastRunAt: null, model: null }), /not run/);
  assert.match(semanticStatusLine({ state: 'failed', lastRunAt: null, model: null }), /failed/);
  assert.match(semanticStatusLine({ state: 'ran', lastRunAt: '2026-10-15T10:00:00Z', model: 'gemma' }), /2026-10-15/);
});
