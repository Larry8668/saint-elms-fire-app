import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseAvailabilitySchema, OptionGroupSchema, ProgrammeRowSchema, ProgrammeSchema } from './programme';
import { makeContractFixtures } from './testing/fixtures';

type AnySchema = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

const rejects = (schema: AnySchema, value: unknown, message?: string) =>
  assert.equal(schema.safeParse(value).success, false, message);

const row = (id: string) => {
  const { programme } = makeContractFixtures();
  const found = programme.rows.find((r) => r.rowId === id);
  assert.ok(found, `fixture row ${id} missing`);
  return found;
};

test('fixture rows cover every required shape', () => {
  const { programme } = makeContractFixtures();
  const byType = new Map(programme.rows.map((r) => [r.courseType, r]));
  assert.equal(row('row-bridge-maths').credits, 0);
  assert.equal(byType.get('Bridge Course')?.courseId, 'bridge-maths');
  assert.equal(row('row-mechanics').credits, 4);
  assert.equal(byType.get('AEC')?.deliveryMode, 'external');
  const internship = row('row-internship');
  assert.equal(internship.hoursPerWeek, null);
  assert.equal(internship.credits, 8);
  assert.equal(internship.deliveryMode, 'internship-workflow');
  assert.equal(row('row-support').courseType, 'Administrative Support');
  const group = programme.optionGroups.find((g) => g.id === 'elective-sem5');
  assert.deepEqual(group?.bundles[0]?.rowIds, ['row-astro-theory', 'row-astro-lab']);
});

test('administrative support uses semester zero and carries no degree credit', () => {
  const support = row('row-support');
  rejects(ProgrammeRowSchema, { ...support, semesterNumber: 3 });
  rejects(ProgrammeRowSchema, { ...support, credits: 2 });
  const mechanics = row('row-mechanics');
  rejects(ProgrammeRowSchema, { ...mechanics, semesterNumber: 0 });
});

test('numeric fields reject negative, NaN and infinite values', () => {
  const mechanics = row('row-mechanics');
  rejects(ProgrammeRowSchema, { ...mechanics, credits: -1 });
  rejects(ProgrammeRowSchema, { ...mechanics, credits: NaN });
  rejects(ProgrammeRowSchema, { ...mechanics, credits: Infinity });
  rejects(ProgrammeRowSchema, { ...mechanics, semesterNumber: -1 });
  rejects(ProgrammeRowSchema, { ...mechanics, semesterNumber: 1.5 });
  rejects(ProgrammeRowSchema, { ...mechanics, hoursPerWeek: -2 });
  rejects(ProgrammeRowSchema, { ...mechanics, hoursPerWeek: NaN });
});

test('identifiers cannot smuggle paths', () => {
  const mechanics = row('row-mechanics');
  for (const bad of ['../etc', 'a/b', '', 'semi;colon']) {
    rejects(ProgrammeRowSchema, { ...mechanics, courseId: bad });
    rejects(ProgrammeRowSchema, { ...mechanics, rowId: bad });
  }
});

test('prerequisite identifiers must be unique', () => {
  const mechanics = row('row-mechanics');
  rejects(ProgrammeRowSchema, { ...mechanics, prerequisites: ['bridge-maths', 'bridge-maths'] });
});

test('cross-row references are not resolved by the schema', () => {
  const mechanics = row('row-mechanics');
  const dangling = { ...mechanics, prerequisites: ['course-that-does-not-exist'], optionGroup: 'not-a-real-group' };
  assert.equal(ProgrammeRowSchema.safeParse(dangling).success, true, 'reference resolution is runtime work');
});

test('contentPath is retained provenance, not a validated install destination', () => {
  const mechanics = row('row-mechanics');
  assert.equal(ProgrammeRowSchema.safeParse({ ...mechanics, contentPath: '../somewhere/else' }).success, true);
});

test('option groups select one complete bundle, preserving its member rows', () => {
  const { programme } = makeContractFixtures();
  const group = programme.optionGroups[0]!;
  rejects(OptionGroupSchema, { ...group, select: 2 });
  rejects(OptionGroupSchema, { ...group, bundles: [] });
  rejects(OptionGroupSchema, { ...group, bundles: [{ id: 'b', rowIds: ['row-astro-theory', 'row-astro-theory'] }] });
});

test('programme requires at least one source document', () => {
  const { programme } = makeContractFixtures();
  rejects(ProgrammeSchema, { ...programme, sourceDocuments: [] });
});

test('course availability axes are independent enums', () => {
  assert.equal(
    CourseAvailabilitySchema.safeParse({ content: 'external', release: 'released', selection: 'not_applicable' }).success,
    true,
  );
  rejects(CourseAvailabilitySchema, { content: 'missing', release: 'released', selection: 'selected', extra: 1 });
});
