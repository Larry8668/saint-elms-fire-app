import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncStatus } from '@sef/shared';
import { groupProgramme, INSTALL_STATES, installStateOf, isSupportRow, metadataCaveat, type ProgrammeCourse } from './programme-rows';

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

test('support rows are separated from degree rows and never inflate a degree total', () => {
  const structure = groupProgramme([
    course('mechanics', { semesterNumber: 1, lessonCount: 4 }),
    course('algebra', { semesterNumber: 1, lessonCount: 2 }),
    course('library-orientation', { semesterNumber: 0, lessonCount: 9, support: true }),
  ]);

  assert.equal(isSupportRow(course('x', { support: true })), true);
  assert.deepEqual(
    structure.degree.map((g) => g.semester),
    [1],
  );
  assert.equal(structure.degree[0]!.degreeCount, 2);
  assert.equal(structure.totals.degreeCourses, 2, 'support must not be counted as a degree course');
  assert.equal(structure.totals.degreeLessons, 6);
  assert.equal(structure.support?.degreeCount, 1);
  assert.equal(structure.totals.supportCourses, 1);
  assert.equal(structure.totals.supportLessons, 9);
});

test('semesters are ordered and the support corpus stays out of that ordering', () => {
  const structure = groupProgramme([
    course('c6', { semesterNumber: 6 }),
    course('c1', { semesterNumber: 1 }),
    course('c3', { semesterNumber: 3 }),
    course('support', { semesterNumber: 0, support: true }),
  ]);
  assert.deepEqual(
    structure.degree.map((g) => g.semester),
    [1, 3, 6],
  );
});

test('every total is counted from the rows, so a stale aggregate cannot disagree', () => {
  const rows = [course('a', { semesterNumber: 1, lessonCount: 1 }), course('b', { semesterNumber: 2, lessonCount: 1 })];
  const structure = groupProgramme(rows);
  const counted = rows.filter((r) => !isSupportRow(r)).reduce((n, r) => n + r.lessonCount, 0);
  assert.equal(structure.totals.degreeLessons, counted);
  assert.equal(structure.totals.degreeCourses, rows.filter((r) => !isSupportRow(r)).length);
});

test('a cohort with no support corpus reports none rather than an empty group', () => {
  const structure = groupProgramme([course('a', { semesterNumber: 1 })]);
  assert.equal(structure.support, null);
  assert.equal(structure.totals.supportCourses, 0);
  assert.equal(structure.totals.supportLessons, 0);
});

test('no released rows at all yields an empty structure with zeroed totals', () => {
  const structure = groupProgramme([]);
  assert.deepEqual(structure.degree, []);
  assert.equal(structure.support, null);
  assert.equal(structure.totals.degreeCourses, 0);
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