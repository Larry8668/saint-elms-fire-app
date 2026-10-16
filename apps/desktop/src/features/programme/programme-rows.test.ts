import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncStatus } from '@sef/shared';
import { INSTALL_STATES, installStateOf, metadataCaveat, type ProgrammeCourse } from './programme-rows';

const course = (id: string, over: Partial<ProgrammeCourse> = {}): ProgrammeCourse => ({
  id,
  title: `Course ${id}`,
  semesterNumber: 1,
  subjectId: 'physics',
  lessonCount: 3,
  state: 'available',
  support: false,
  ...over,
});

test('every install state has its own wording, and an unknown state cannot crash the view', () => {
  const labels = (['installed', 'update', 'available', 'local-only'] as const).map((state) => installStateOf(course('x', { state })).label);
  assert.equal(new Set(labels).size, 4);

  const drifted = course('x', { state: 'archived' as SyncStatus['courses'][number]['state'] });
  const unknown = installStateOf(drifted);
  assert.match(unknown.label, /not recognised/);
  assert.notEqual(unknown.label, INSTALL_STATES.installed.label, 'an unknown state must never read as installed');
});

test('an unsigned install is flagged and a signed one is not', () => {
  assert.match(metadataCaveat(course('x', { signedMetadata: false })) ?? '', /metadata missing/);
  assert.equal(metadataCaveat(course('x', { signedMetadata: true })), null);
  assert.equal(metadataCaveat(course('x')), null, 'an unreported caveat is not a warning');
});
