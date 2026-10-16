import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AcademicStatus, DeviceProfile, ProgrammeManifestResponse, SyncStatus } from '@sef/shared';
import { makeContractFixtures } from '@sef/shared/testing';
import { EngineError } from '@/lib/api';
import {
  academicStatusOf,
  availabilityNoteOf,
  creditsLabelOf,
  hoursLabelOf,
  prerequisiteLabelsOf,
  refusalOf,
  statusLabelOf,
  viewOfManifest,
  type ManifestRowView,
} from './manifest-view';

const manifest = (): ProgrammeManifestResponse => {
  const { programme } = makeContractFixtures();
  return {
    programme,
    semesters: [
      { id: 'sem-1', name: 'Semester 1', number: 1, rowIds: ['row-bridge-maths', 'row-mechanics', 'row-english'] },
      { id: 'sem-4', name: 'Semester 4', number: 4, rowIds: ['row-internship'] },
      { id: 'sem-5', name: 'Semester 5', number: 5, rowIds: ['row-astro-theory', 'row-astro-lab'], optionGroupNote: 'Pick one theory plus its matching lab.' },
      { id: 'support', name: 'University support', number: 0, rowIds: ['row-support'] },
    ],
    derivedCounts: {
      rows: 7,
      bySemester: { '0': 1, '1': 3, '4': 1, '5': 2 },
      byStatus: { released: 2, external: 1, pending: 1, planned: 2, out_of_scope: 1 },
      degreeRows: 6,
      degreeCredits: { min: 16, max: 16 },
    },
    availability: {
      'row-bridge-maths': { content: 'authored', release: 'released', selection: 'not_applicable' },
      'row-mechanics': { content: 'authored', release: 'released', selection: 'not_applicable' },
      'row-english': { content: 'external', release: 'unreleased', selection: 'not_applicable' },
      'row-internship': { content: 'workflow', release: 'unreleased', selection: 'not_applicable' },
      'row-astro-theory': { content: 'authored', release: 'unreleased', selection: 'not_applicable' },
      'row-astro-lab': { content: 'authored', release: 'unreleased', selection: 'not_applicable' },
      // row-support is deliberately absent: availability must come back null, not invented.
    },
  };
};

const rowView = (rowId: string): ManifestRowView => {
  const m = manifest();
  const row = m.programme.rows.find((r) => r.rowId === rowId)!;
  return { row, availability: m.availability[rowId] ?? null };
};

const syncRow = (id: string, state: SyncStatus['courses'][number]['state']): SyncStatus['courses'][number] => ({
  id,
  title: `Course ${id}`,
  semesterNumber: 1,
  subjectId: 'physics',
  lessonCount: 3,
  state,
  support: false,
});

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({ uniReachable: true, cohortId: 'cohort-a', courses: [], ...over });

const profile = (over: Partial<DeviceProfile> = {}): DeviceProfile => ({
  id: 'profile-1',
  name: 'Ada',
  email: 'ada@example.test',
  cohortId: 'cohort-a',
  offlineReady: true,
  ...over,
});

test('the support corpus is separated from degree semesters and never inflates degree counts', () => {
  const view = viewOfManifest(manifest());
  assert.deepEqual(
    view.degree.map((semester) => semester.number),
    [1, 4, 5],
  );
  assert.equal(view.support?.number, 0);
  assert.equal(view.counts.degreeRows, 6, 'support rows must not be counted as degree rows');
  assert.equal(view.counts.supportRows, 1);
});

test('option groups resolve into complete bundles and leave the plain row list', () => {
  const view = viewOfManifest(manifest());
  const sem5 = view.degree.find((semester) => semester.number === 5)!;
  assert.equal(sem5.rows.length, 0, 'option rows render inside their bundle, not loose');
  assert.equal(sem5.optionGroups.length, 1);
  assert.deepEqual(
    sem5.optionGroups[0]!.bundles[0]!.rows.map((v) => v.row.rowId),
    ['row-astro-theory', 'row-astro-lab'],
  );
  assert.equal(sem5.optionGroupNote, 'Pick one theory plus its matching lab.');
  assert.equal(view.counts.optionGroups, 1);
  assert.equal(view.counts.bundles, 1);
});

test('nullable hours and zero credits pass through with honest labels', () => {
  const view = viewOfManifest(manifest());
  const bridge = view.degree[0]!.rows.find((v) => v.row.rowId === 'row-bridge-maths')!;
  assert.equal(bridge.row.credits, 0);
  assert.equal(creditsLabelOf(bridge.row), '0 credits');
  const internship = view.degree[1]!.rows[0]!;
  assert.equal(internship.row.hoursPerWeek, null);
  assert.equal(hoursLabelOf(internship.row), 'Hours not published');
  assert.equal(hoursLabelOf(bridge.row), '2 h/week');
  assert.equal(creditsLabelOf(rowView('row-astro-lab').row), '1 credit');
});

test('a row the uni served no availability for gets null, not a fabricated state', () => {
  const view = viewOfManifest(manifest());
  assert.equal(view.support!.rows[0]!.availability, null);
});

test('a semester referencing an unknown row is counted, never resolved to a guess', () => {
  const m = manifest();
  m.semesters[0]!.rowIds.push('row-ghost');
  const view = viewOfManifest(m);
  assert.equal(view.missingRowRefs, 1);
  assert.equal(view.counts.degreeRows, 6, 'a ghost reference must not become a row');
});

test('rows no semester lists surface as unlisted rather than being dropped', () => {
  const m = manifest();
  m.semesters[1]!.rowIds = [];
  const view = viewOfManifest(m);
  assert.deepEqual(
    view.unlisted.map((v) => v.row.rowId),
    ['row-internship'],
  );
});

test('every academic status has its own wording, and an unknown status cannot read as released', () => {
  const base = rowView('row-mechanics').row;
  const labels = (['released', 'in_authoring', 'planned', 'external', 'pending', 'out_of_scope'] as const).map(
    (status) => academicStatusOf({ ...base, status }).label,
  );
  assert.equal(new Set(labels).size, 6);

  const drifted = { ...rowView('row-mechanics').row, status: 'archived' as AcademicStatus };
  const unknown = academicStatusOf(drifted);
  assert.match(unknown.label, /not recognised/);
  assert.notEqual(unknown.label, academicStatusOf({ ...drifted, status: 'released' }).label);
});

test('status labels for server aggregates map known values and humanize the rest', () => {
  assert.equal(statusLabelOf('in_authoring'), 'Being written');
  assert.equal(statusLabelOf('released'), 'Released');
  assert.equal(statusLabelOf('some_future_state'), 'some future state');
});

test('prerequisites render as course codes where the target row was served', () => {
  const m = manifest();
  assert.deepEqual(prerequisiteLabelsOf(rowView('row-mechanics').row, m), ['BRD-101']);
  const dangling = { ...rowView('row-mechanics').row, prerequisites: ['not-served'] };
  assert.deepEqual(prerequisiteLabelsOf(dangling, m), ['not-served']);
});

test('availability decides what a row may offer, and unreleased rows offer nothing', () => {
  assert.match(availabilityNoteOf(rowView('row-english'), undefined) ?? '', /no package to install/);
  assert.match(availabilityNoteOf(rowView('row-internship'), undefined) ?? '', /internship workflow/);
  assert.match(availabilityNoteOf({ ...rowView('row-support') }, undefined) ?? '', /no availability/);

  const unreleased = { row: rowView('row-astro-theory').row, availability: { content: 'authored', release: 'unreleased', selection: 'not_applicable' } as const };
  assert.equal(availabilityNoteOf(unreleased, undefined), null, 'the status badge already says it is not released');

  const missing = { row: rowView('row-mechanics').row, availability: { content: 'missing', release: 'released', selection: 'not_applicable' } as const };
  assert.match(availabilityNoteOf(missing, undefined) ?? '', /No courseware files/);

  const released = rowView('row-mechanics');
  assert.match(availabilityNoteOf(released, undefined) ?? '', /not to your cohort/);
  assert.match(availabilityNoteOf(released, syncRow('classical-mechanics', 'available')) ?? '', /Released courses tab/);
  assert.equal(availabilityNoteOf(released, syncRow('classical-mechanics', 'installed')), null, 'installed rows get the open action instead');
});

test('the engine refusal maps to an honest reason, never a raw code', () => {
  const approved = profile({ admission: 'approved' });
  const legacy = profile();

  assert.equal(refusalOf(new EngineError('Enrolment is not approved', 403, 'unapproved'), status(), approved), 'admission');
  assert.equal(refusalOf(new EngineError('conflict', 409, 'invalid_transition'), status(), approved), 'conflict');
  assert.equal(refusalOf(new EngineError('programme_unavailable', 503), status({ authRequired: true }), approved), 'no_session');
  assert.equal(refusalOf(new EngineError('programme_unavailable', 503), status({ uniReachable: false }), approved), 'uni_unreachable');
  assert.equal(refusalOf(new EngineError('programme_unavailable', 503), status(), legacy), 'admission');
  assert.equal(refusalOf(new EngineError('programme_unavailable', 503), status(), approved), 'unavailable');
  assert.equal(refusalOf(new EngineError('The local engine is not running. Start it with "pnpm dev".', 0), undefined, approved), 'unavailable');
  assert.equal(refusalOf(new Error('boom'), undefined, approved), 'unavailable');
});
