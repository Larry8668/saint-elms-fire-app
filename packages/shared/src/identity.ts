import { z } from 'zod';
import { ContractVersionSchema, IdentifierSchema, ProfileIdentitySchema, RevisionSchema, TimestampSchema } from './contracts';

export const InstitutionalRoleSchema = z.enum(['student', 'university_admin', 'university_owner']);
export type InstitutionalRole = z.infer<typeof InstitutionalRoleSchema>;

export const StudentIdentitySchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  email: z.email(),
  name: z.string().trim().min(1).max(80),
  emailVerified: z.boolean(),
  status: z.enum(['active', 'suspended']),
  roles: z.array(InstitutionalRoleSchema),
  createdAt: TimestampSchema,
});
export type StudentIdentity = z.infer<typeof StudentIdentitySchema>;

export const EnrolmentStatusSchema = z.enum(['pending', 'approved', 'rejected', 'suspended', 'withdrawn']);
export type EnrolmentStatus = z.infer<typeof EnrolmentStatusSchema>;

const decision = z.strictObject({
  actorId: IdentifierSchema,
  at: TimestampSchema,
  reason: z.string().trim().min(1).max(2000),
});

export const EnrolmentSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    id: IdentifierSchema,
    studentId: IdentifierSchema,
    programmeId: IdentifierSchema,
    curriculumVersion: RevisionSchema,
    status: EnrolmentStatusSchema,
    cohortId: IdentifierSchema.nullable(),
    version: z.number().int().min(1),
    requestedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    decision: decision.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'pending' && (value.cohortId !== null || value.decision !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Pending enrolment cannot contain an assigned cohort or decision',
      });
    }
    if ((value.status === 'approved' || value.status === 'suspended') && !value.cohortId) {
      ctx.addIssue({ code: 'custom', path: ['cohortId'], message: 'Approved or suspended enrolment requires a cohort' });
    }
    if (value.status !== 'pending' && !value.decision) {
      ctx.addIssue({ code: 'custom', path: ['decision'], message: 'Decided enrolment requires decision provenance' });
    }
    if (Date.parse(value.updatedAt) < Date.parse(value.requestedAt)) {
      ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Update precedes application' });
    }
    if (
      value.decision &&
      (Date.parse(value.decision.at) < Date.parse(value.requestedAt) ||
        Date.parse(value.decision.at) > Date.parse(value.updatedAt))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision', 'at'],
        message: 'Decision must fall between application and last update',
      });
    }
  });
export type Enrolment = z.infer<typeof EnrolmentSchema>;

export const EnrolmentApplicationSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  programmeId: IdentifierSchema,
});
export type EnrolmentApplication = z.infer<typeof EnrolmentApplicationSchema>;

export const EnrolmentDecisionRequestSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    expectedVersion: z.number().int().min(1),
    action: z.enum(['approve', 'reject', 'suspend', 'reinstate', 'assign_cohort']),
    reason: z.string().trim().min(1).max(2000),
    cohortId: IdentifierSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const assigns = value.action === 'approve' || value.action === 'assign_cohort';
    if (assigns !== Boolean(value.cohortId)) {
      ctx.addIssue({ code: 'custom', path: ['cohortId'], message: 'Only approval or cohort assignment supplies a cohort' });
    }
  });
export type EnrolmentDecisionRequest = z.infer<typeof EnrolmentDecisionRequestSchema>;

export const StudentProfileContextSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  identity: ProfileIdentitySchema,
  enrolmentId: IdentifierSchema,
  cohortId: IdentifierSchema,
});
export type StudentProfileContext = z.infer<typeof StudentProfileContextSchema>;
