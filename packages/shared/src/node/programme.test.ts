import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify as yaml } from 'yaml';
import { ProgrammeSchema } from '../programme';
import { loadProgrammeManifest, ProgrammeManifestError, resolveContentDir } from './programme';

/** Writes a minimal valid manifest so fixtures can override a single aspect. */
async function fixture(overrides: {
  rows?: unknown[];
  optionGroups?: unknown[];
  counts?: Record<string, unknown>;
  programmeId?: string;
  sectionKey?: string;
}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-manifest-'));
  await mkdir(path.join(dir, 'semester-1', 'physics', 'mechanics'), { recursive: true });
  await writeFile(path.join(dir, 'semester-1', 'physics', 'mechanics', 'm1-l1.md'), '***\ncourseId: mechanics\n***\n# M1L1\n');
  const manifest = {
    programmeId: overrides.programmeId ?? 'bsc-test',
    programmeName: 'Test Programme',
    institution: 'Test University',
    sourcePdfs: ['syllabus.pdf'],
    manifestVersion: 'test-1',
    optionGroups: overrides.optionGroups ?? [],
    counts: overrides.counts ?? { bySemester: { 'sem-1': 1 }, byStatus: { released: 1 }, total: 1 },
    [overrides.sectionKey ?? 'semester-1']: {
      semesterId: 'sem-1',
      rows: overrides.rows ?? [
        {
          rowId: 'r-1',
          courseCode: 'PHY-101',
          courseId: 'mechanics',
          courseName: 'Mechanics',
          subjectId: 'physics',
          courseType: 'Major Core',
          hoursPerWeek: 4,
          credits: 4,
          optionGroup: null,
          deliveryMode: 'authored-courseware',
          prerequisites: [],
          status: 'released',
          contentPath: 'content/semester-1/physics/mechanics/',
        },
      ],
    },
  };
  await writeFile(path.join(dir, 'programme-manifest.yaml'), yamlString(manifest));
  return dir;
}

function yamlString(value: unknown): string {
  return yaml(value);
}

test('fixture manifest round-trips into the Programme contract', async () => {
  const dir = await fixture({});
  const result = await loadProgrammeManifest(dir);
  ProgrammeSchema.parse(result.programme);
  assert.equal(result.programme.id, 'bsc-test');
  assert.equal(result.programme.rows.length, 1);
  assert.equal(result.programme.rows[0]!.rowId, 'r-1');
  assert.equal(result.programme.rows[0]!.semesterNumber, 1);
  assert.equal(result.semesters[0]!.id, 'sem-1');
  assert.deepEqual(result.derivedCounts, {
    rows: 1,
    bySemester: { 1: 1 },
    byStatus: { released: 1 },
    degreeRows: 1,
    degreeCredits: { min: 4, max: 4 },
  });
  assert.equal(result.diagnostics.length, 0);
});

test('sem-N section keys are normalized into programme rows', async () => {
  const dir = await fixture({ sectionKey: 'sem-1' });
  const result = await loadProgrammeManifest(dir);

  assert.deepEqual(result.programme.rows.map(({ rowId, semesterNumber }) => ({ rowId, semesterNumber })), [
    { rowId: 'r-1', semesterNumber: 1 },
  ]);
  assert.equal(result.semesters.length, 1);
  assert.equal(result.semesters[0]!.number, 1);
  assert.deepEqual(result.semesters[0]!.rowIds, ['r-1']);
});

test('null hoursPerWeek, zero credits and support rows survive normalization', async () => {
  const dir = await fixture({
    rows: [
      {
        rowId: 'r-internship',
        courseCode: 'INT-400',
        courseId: 'internship',
        courseName: 'Internship',
        subjectId: 'physics',
        courseType: 'Internship',
        hoursPerWeek: null,
        credits: 8,
        optionGroup: null,
        deliveryMode: 'internship-workflow',
        prerequisites: [],
        status: 'planned',
      },
      {
        rowId: 'r-orientation',
        courseCode: 'ORI-000',
        courseId: 'orientation',
        courseName: 'Orientation',
        subjectId: 'physics',
        courseType: 'Bridge Course',
        hoursPerWeek: 2,
        credits: 0,
        optionGroup: null,
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
    ],
    counts: { bySemester: { 'sem-1': 2 }, byStatus: { released: 1, planned: 1 }, total: 2 },
  });
  const result = await loadProgrammeManifest(dir);
  const internship = result.programme.rows.find((r) => r.courseId === 'internship')!;
  assert.equal(internship.hoursPerWeek, null);
  assert.equal(internship.credits, 8);
  const orientation = result.programme.rows.find((r) => r.courseId === 'orientation')!;
  assert.equal(orientation.credits, 0);
  assert.equal(result.diagnostics.length, 0);
});

test('duplicate courseIds and unknown prerequisites fail explicitly', async () => {
  const dir = await fixture({
    rows: [
      {
        rowId: 'r-1',
        courseCode: 'PHY-101',
        courseId: 'mechanics',
        courseName: 'Mechanics',
        subjectId: 'physics',
        courseType: 'Major Core',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: null,
        deliveryMode: 'authored-courseware',
        prerequisites: ['course-that-does-not-exist'],
        status: 'released',
      },
      {
        rowId: 'r-2',
        courseCode: 'PHY-102',
        courseId: 'mechanics',
        courseName: 'Mechanics Again',
        subjectId: 'physics',
        courseType: 'Major Core',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: null,
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
    ],
    counts: { bySemester: { 'sem-1': 2 }, byStatus: { released: 2 }, total: 2 },
  });
  await assert.rejects(loadProgrammeManifest(dir), (error: unknown) => {
    assert.ok(error instanceof ProgrammeManifestError);
    const codes = new Set(error.diagnostics.filter((d) => d.level === 'error').map((d) => d.code));
    assert.deepEqual(codes, new Set(['duplicate_course_id', 'unknown_prerequisite']));
    return true;
  });
});

test('option group bundles must cover their rows exactly', async () => {
  const dir = await fixture({
    rows: [
      {
        rowId: 'r-theory',
        courseCode: 'PHY-302A',
        courseId: 'astro-theory',
        courseName: 'Astronomy Theory',
        subjectId: 'physics',
        courseType: 'Major Elective',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: 'sem5-physics-option',
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
      {
        rowId: 'r-lab',
        courseCode: 'PHY-312A',
        courseId: 'astro-lab',
        courseName: 'Astronomy Lab',
        subjectId: 'physics',
        courseType: 'Lab',
        hoursPerWeek: 2,
        credits: 1,
        optionGroup: 'sem5-physics-option',
        deliveryMode: 'authored-courseware',
        prerequisites: ['astro-theory'],
        status: 'released',
      },
    ],
    optionGroups: [{ id: 'sem5-physics-option', select: 1, bundles: [{ id: 'b-1', rowIds: ['r-theory'] }] }],
    counts: { bySemester: { 'sem-1': 2 }, byStatus: { released: 2 }, total: 2 },
  });
  await assert.rejects(loadProgrammeManifest(dir), (error: unknown) => {
    assert.ok(error instanceof ProgrammeManifestError);
    assert.ok(error.diagnostics.some((d) => d.level === 'error' && d.code === 'row_missing_from_bundles'));
    return true;
  });
});

test('malformed rows and undefined option groups are rejected', async () => {
  const dir = await fixture({
    rows: [
      {
        rowId: 'r-1',
        courseCode: 'PHY-101',
        courseId: 'mechanics',
        courseName: 'Mechanics',
        subjectId: 'physics',
        courseType: 'Major Core',
        hoursPerWeek: -3,
        credits: 4,
        optionGroup: 'no-such-group',
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
    ],
  });
  await assert.rejects(loadProgrammeManifest(dir), /hoursPerWeek/);
});

test('elective alternatives are counted once in credit diagnostics', async () => {
  const dir = await fixture({
    rows: [
      {
        rowId: 'r-core',
        courseCode: 'PHY-101',
        courseId: 'mechanics',
        courseName: 'Mechanics',
        subjectId: 'physics',
        courseType: 'Major Core',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: null,
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
      {
        rowId: 'r-theory-a',
        courseCode: 'PHY-302A',
        courseId: 'astro-theory',
        courseName: 'Astronomy Theory',
        subjectId: 'physics',
        courseType: 'Major Elective',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: 'sem5-physics-option',
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
      {
        rowId: 'r-lab-a',
        courseCode: 'PHY-312A',
        courseId: 'astro-lab',
        courseName: 'Astronomy Lab',
        subjectId: 'physics',
        courseType: 'Lab',
        hoursPerWeek: 2,
        credits: 1,
        optionGroup: 'sem5-physics-option',
        deliveryMode: 'authored-courseware',
        prerequisites: ['astro-theory'],
        status: 'released',
      },
      {
        rowId: 'r-theory-b',
        courseCode: 'PHY-302B',
        courseId: 'micro-theory',
        courseName: 'Micro Theory',
        subjectId: 'physics',
        courseType: 'Major Elective',
        hoursPerWeek: 4,
        credits: 4,
        optionGroup: 'sem5-physics-option',
        deliveryMode: 'authored-courseware',
        prerequisites: [],
        status: 'released',
      },
      {
        rowId: 'r-lab-b',
        courseCode: 'PHY-312B',
        courseId: 'micro-lab',
        courseName: 'Micro Lab',
        subjectId: 'physics',
        courseType: 'Lab',
        hoursPerWeek: 2,
        credits: 1,
        optionGroup: 'sem5-physics-option',
        deliveryMode: 'authored-courseware',
        prerequisites: ['micro-theory'],
        status: 'released',
      },
    ],
    optionGroups: [
      {
        id: 'sem5-physics-option',
        select: 1,
        bundles: [
          { id: 'b-a', rowIds: ['r-theory-a', 'r-lab-a'] },
          { id: 'b-b', rowIds: ['r-theory-b', 'r-lab-b'] },
        ],
      },
    ],
    counts: { bySemester: { 'sem-1': 5 }, byStatus: { released: 5 }, total: 5 },
  });
  const result = await loadProgrammeManifest(dir);
  // 4 core + one 5-credit bundle; the other alternative must not inflate the total.
  assert.deepEqual(result.derivedCounts.degreeCredits, { min: 9, max: 9 });
  assert.equal(result.derivedCounts.degreeRows, 5);
});

test('stale aggregate counts are reconciled, not trusted', async () => {
  const dir = await fixture({
    counts: { bySemester: { 'sem-1': 2 }, byStatus: { released: 9 }, total: 9 },
  });
  const result = await loadProgrammeManifest(dir);
  const stale = result.diagnostics.filter((d) => d.code.startsWith('stale_'));
  assert.ok(stale.length >= 2, `expected stale aggregate warnings, got ${result.diagnostics.map((d) => d.code).join(',')}`);
  assert.equal(result.derivedCounts.rows, 1);
});

test('historic content/ paths resolve under the current courseware root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-paths-'));
  await mkdir(path.join(dir, 'semester-1', 'physics', 'mechanics'), { recursive: true });
  const resolved = resolveContentDir('content/semester-1/physics/mechanics/', dir);
  assert.equal(resolved, path.join(dir, 'semester-1', 'physics', 'mechanics'));
  assert.equal(resolveContentDir('../outside', dir), null);
  assert.equal(resolveContentDir(undefined, dir), null);
});
