import { z } from 'zod';
import {
  ContractVersionSchema,
  IdentifierSchema,
  IdentifierListSchema,
  NonemptyIdentifiersSchema,
  RevisionSchema,
} from './contracts';

export const CourseTypeSchema = z.enum([
  'Bridge Course',
  'Major Core',
  'Lab',
  'Minor',
  'SEC',
  'Computational SEC',
  'AEC',
  'VAC',
  'Open Elective',
  'Major Elective',
  'Computational Lab',
  'Internship',
  'Administrative Support',
]);
export type CourseType = z.infer<typeof CourseTypeSchema>;

export const DeliveryModeSchema = z.enum(['authored-courseware', 'external', 'internship-workflow']);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const AcademicStatusSchema = z.enum(['released', 'in_authoring', 'planned', 'external', 'pending', 'out_of_scope']);
export type AcademicStatus = z.infer<typeof AcademicStatusSchema>;

export const ProgrammeRowSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    rowId: IdentifierSchema,
    courseId: IdentifierSchema,
    courseCode: z.string().min(1).max(80),
    courseName: z.string().min(1).max(300),
    subjectId: IdentifierSchema,
    semesterNumber: z.number().int().nonnegative(),
    courseType: CourseTypeSchema,
    hoursPerWeek: z.number().nonnegative().nullable(),
    credits: z.number().nonnegative(),
    optionGroup: IdentifierSchema.nullable(),
    deliveryMode: DeliveryModeSchema,
    prerequisites: IdentifierListSchema,
    status: AcademicStatusSchema,
    packageTemplate: z.string().min(1).optional(),
    contentPath: z.string().min(1).optional(),
    notes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.courseType === 'Administrative Support') !== (value.semesterNumber === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['semesterNumber'],
        message: 'Semester zero is reserved for administrative support',
      });
    }
    if (value.courseType === 'Administrative Support' && value.credits !== 0) {
      ctx.addIssue({ code: 'custom', path: ['credits'], message: 'Support is not degree credit' });
    }
  });
export type ProgrammeRow = z.infer<typeof ProgrammeRowSchema>;

export const ElectiveBundleSchema = z.strictObject({
  id: IdentifierSchema,
  rowIds: NonemptyIdentifiersSchema,
});
export type ElectiveBundle = z.infer<typeof ElectiveBundleSchema>;

export const OptionGroupSchema = z.strictObject({
  id: IdentifierSchema,
  select: z.literal(1),
  bundles: z.array(ElectiveBundleSchema).min(1),
});
export type OptionGroup = z.infer<typeof OptionGroupSchema>;

export const ProgrammeSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  name: z.string().min(1),
  institution: z.string().min(1),
  manifestVersion: RevisionSchema,
  sourceDocuments: z.array(z.string().min(1)).min(1),
  rows: z.array(ProgrammeRowSchema),
  optionGroups: z.array(OptionGroupSchema),
});
export type Programme = z.infer<typeof ProgrammeSchema>;

export const CourseAvailabilitySchema = z.strictObject({
  content: z.enum(['authored', 'external', 'workflow', 'missing']),
  release: z.enum(['released', 'unreleased']),
  selection: z.enum(['required', 'selected', 'not_selected', 'not_applicable']),
});
export type CourseAvailability = z.infer<typeof CourseAvailabilitySchema>;

/**
 * `GET /v1/programme` — the full curriculum manifest.
 *
 * Only reachable by staff or a live approved enrolment. Declared here because it crosses the
 * uni → engine boundary and the engine must validate it before rendering; without this the
 * only guard was `typeof response === 'object'`.
 */
export const ProgrammeSemesterSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1),
  /** 0 is the cross-semester support corpus, which must not inflate degree totals. */
  number: z.number().int(),
  rowIds: z.array(IdentifierSchema),
  optionGroupNote: z.string().optional(),
});
export type ProgrammeSemester = z.infer<typeof ProgrammeSemesterSchema>;

/**
 * What the uni derives from the rows and serves as `derivedCounts`. Row counts are plain
 * aggregates; degree credits are a range, because exactly one bundle per option group is
 * selected and the alternatives must not inflate the total.
 */
export const ProgrammeCountsSchema = z.strictObject({
  /** Every row in the programme, support included. */
  rows: z.number().int().min(0),
  bySemester: z.record(z.string(), z.number().int().min(0)),
  byStatus: z.record(z.string(), z.number().int().min(0)),
  /** Rows that count toward the degree: semester rows, support excluded. */
  degreeRows: z.number().int().min(0),
  /** Degree credit if exactly one bundle per option group is selected. */
  degreeCredits: z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative() }),
});
export type ProgrammeCounts = z.infer<typeof ProgrammeCountsSchema>;

export const ProgrammeManifestResponseSchema = z.strictObject({
  programme: ProgrammeSchema,
  semesters: z.array(ProgrammeSemesterSchema),
  derivedCounts: ProgrammeCountsSchema,
  /** Keyed by row id; a row absent here is simply not available to this student. */
  availability: z.record(IdentifierSchema, CourseAvailabilitySchema),
});
export type ProgrammeManifestResponse = z.infer<typeof ProgrammeManifestResponseSchema>;

/**
 * Programme identity only, for a verified applicant who has not been approved yet. It
 * carries no rows, semesters or release state, so it is not a way to read the curriculum
 * before admission.
 */
export const ProgrammeSummarySchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(200),
  institution: z.string().trim().min(1).max(200),
});
export type ProgrammeSummary = z.infer<typeof ProgrammeSummarySchema>;

export const ProgrammeCatalogueSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  programmes: z.array(ProgrammeSummarySchema),
});
export type ProgrammeCatalogue = z.infer<typeof ProgrammeCatalogueSchema>;
