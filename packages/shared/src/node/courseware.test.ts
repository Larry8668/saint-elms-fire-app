import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCourseware } from './courseware';

test('without a manifest, the legacy support detection still applies', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-cw-'));
  const lesson = path.join(dir, 'university-support', 'student-life', 'l1.md');
  await mkdir(path.dirname(lesson), { recursive: true });
  await writeFile(
    lesson,
    '***\ncourseId: student-life\nsubjectId: university-support\nsemesterNumber: 0\n***\n# Welcome\n',
  );
  const index = await loadCourseware(dir);
  assert.equal(index.programme, undefined);
  const course = index.courses.get('student-life');
  assert.ok(course);
  assert.equal(course.summary.support, true);
  assert.equal(course.summary.semesterNumber, 0);
});

test('with a manifest, the Administrative Support row is authoritative for the flag', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-cw-'));
  const lesson = path.join(dir, 'university-support', 'student-life', 'l1.md');
  await mkdir(path.dirname(lesson), { recursive: true });
  await writeFile(
    lesson,
    '***\ncourseId: student-life\nsubjectId: university-support\nsemesterNumber: 0\n***\n# Welcome\n',
  );
  const manifest = {
    programmeId: 'bsc-test',
    programmeName: 'Test',
    institution: 'Test University',
    sourcePdfs: ['syllabus.pdf'],
    manifestVersion: 'v1',
    optionGroups: [],
    counts: { bySemester: { 'sem-1': 0 }, byStatus: { released: 1 }, total: 1 },
    support: {
      semesterId: 'support',
      rows: [
        {
          rowId: 'r-support',
          courseCode: 'SUP-000',
          courseId: 'student-life',
          courseName: 'Student Life',
          subjectId: 'university-support',
          courseType: 'Administrative Support',
          hoursPerWeek: null,
          credits: 0,
          optionGroup: null,
          deliveryMode: 'authored-courseware',
          prerequisites: [],
          status: 'released',
        },
      ],
    },
  };
  const { stringify } = await import('yaml');
  await writeFile(path.join(dir, 'programme-manifest.yaml'), stringify(manifest));
  const index = await loadCourseware(dir);
  const course = index.courses.get('student-life');
  assert.ok(course);
  assert.equal(course.summary.support, true);
  assert.equal(course.summary.courseType, 'Administrative Support');
});
