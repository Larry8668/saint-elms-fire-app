import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProgrammeManifestResponseSchema } from '../programme';
import { availabilityFor, courseFilesIn, loadProgrammeManifest } from './programme';

// The checked-in courseware is the project's source of truth; these tests
// pin the normalized model to it so manifest edits are verified by CI.
const COURSEWARE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../courseware');

test('the real manifest loads into the Programme contract', async () => {
  const result = await loadProgrammeManifest(COURSEWARE);
  assert.equal(result.programme.id, 'bsc-physics-mathematics-astrophysics');
  assert.equal(result.programme.institution, 'Christ University, Bangalore');
  assert.deepEqual(result.programme.sourceDocuments, ['BScPM_Astropysics2024_20241109100918.pdf']);
  assert.equal(result.programme.rows.length, 72);
  assert.equal(result.semesters.length, 7);
  assert.equal(result.semesters[0]!.number, 1);
  assert.equal(result.semesters[6]!.number, 0, 'support corpus is semester zero');
  assert.deepEqual(
    result.derivedCounts.bySemester,
    { 0: 1, 1: 11, 2: 12, 3: 8, 4: 10, 5: 12, 6: 18 },
  );
  assert.equal(result.derivedCounts.degreeRows, 71, 'support is excluded from the degree');
  // Required rows: everything outside the five option groups. Elective min/max
  // come from selecting exactly one bundle per group.
  assert.ok(result.derivedCounts.degreeCredits.min > 0 && result.derivedCounts.degreeCredits.max >= result.derivedCounts.degreeCredits.min);
});

test('the real manifest encodes theory-lab pairing as complete bundles', async () => {
  const result = await loadProgrammeManifest(COURSEWARE);
  const physics = result.programme.optionGroups.find((g) => g.id === 'sem5-physics-option')!;
  assert.equal(physics.select, 1);
  assert.equal(physics.bundles.length, 3);
  for (const bundle of physics.bundles) {
    const rows = bundle.rowIds.map((id) => result.programme.rows.find((r) => r.rowId === id)!);
    const types = rows.map((r) => r.courseType).sort();
    assert.deepEqual(types, ['Lab', 'Major Elective'], 'each physics bundle is one theory plus its matching lab');
  }
  // Every row claiming an option group is covered by exactly one bundle.
  const covered = new Map<string, number>();
  for (const group of result.programme.optionGroups) {
    for (const bundle of group.bundles) {
      for (const rowId of bundle.rowIds) covered.set(rowId, (covered.get(rowId) ?? 0) + 1);
    }
  }
  for (const row of result.programme.rows) {
    if (row.optionGroup) assert.equal(covered.get(row.rowId) ?? 0, 1, `${row.rowId} must appear in exactly one bundle`);
  }
});

test('the real manifest has no structural errors, only stale aggregate warnings', async () => {
  const result = await loadProgrammeManifest(COURSEWARE);
  const errors = result.diagnostics.filter((d) => d.level === 'error');
  assert.deepEqual(errors, [], `structural errors found: ${errors.map((d) => d.code).join(',')}`);
  // The checked-in counts block predates the authoring sprint; the loader must flag it.
  const stale = result.diagnostics.filter((d) => d.level === 'warn' && d.code.startsWith('stale_'));
  assert.ok(stale.length >= 3, `expected stale aggregate warnings, got: ${result.diagnostics.map((d) => d.code).join(',')}`);
});

test('internship null hours and zero-credit orientation survive in the real manifest', async () => {
  const result = await loadProgrammeManifest(COURSEWARE);
  const internship = result.programme.rows.find((r) => r.courseId === 'internship')!;
  assert.equal(internship.hoursPerWeek, null);
  assert.equal(internship.credits, 8);
  assert.equal(internship.deliveryMode, 'internship-workflow');
  assert.equal(internship.status, 'planned');
  const bridge = result.programme.rows.find((r) => r.courseId === 'bridge-physics')!;
  assert.equal(bridge.credits, 0);
  assert.equal(bridge.courseType, 'Bridge Course');
  const support = result.programme.rows.find((r) => r.courseType === 'Administrative Support')!;
  assert.equal(support.semesterNumber, 0);
  assert.equal(support.credits, 0);
  const external = result.programme.rows.filter((r) => r.deliveryMode === 'external');
  assert.equal(external.length, 13);
});

test('the response the uni serves parses as ProgrammeManifestResponse', async () => {
  // server/uni routes/student.ts serves exactly this envelope; the engine validates it
  // with this schema before any UI sees it, so a drift here 503s every student.
  const result = await loadProgrammeManifest(COURSEWARE);
  const availability: Record<string, unknown> = {};
  for (const row of result.programme.rows) {
    availability[row.rowId] = availabilityFor(row, await courseFilesIn(COURSEWARE, row));
  }
  const served = {
    programme: result.programme,
    semesters: result.semesters,
    derivedCounts: result.derivedCounts,
    availability,
  };
  const parsed = ProgrammeManifestResponseSchema.safeParse(served);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues.slice(0, 5)));
  if (parsed.success) {
    assert.equal(parsed.data.derivedCounts.degreeRows, 71);
    assert.equal(parsed.data.derivedCounts.rows, 72, 'support rows stay in the total, out of degreeRows');
    assert.ok(Object.keys(parsed.data.availability).length > 0);
  }
});
