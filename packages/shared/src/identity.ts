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

// ---- Admission surfaces (PR-05) ----

/** Operational staff roles as stored; `owner` maps to the university_owner institutional role. */
export const StaffRoleSchema = z.enum(['owner', 'registrar', 'lecturer', 'support']);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const StaffMembershipStatusSchema = z.enum(['active', 'suspended', 'ended']);
export type StaffMembershipStatus = z.infer<typeof StaffMembershipStatusSchema>;

export const StaffMembershipSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  /** The staff member's account subject (better-auth user id); intentionally not an Identifier. */
  subject: z.string().min(1).max(255),
  displayName: z.string().trim().min(1).max(200),
  role: StaffRoleSchema,
  institutionalRole: InstitutionalRoleSchema,
  status: StaffMembershipStatusSchema,
  createdAt: TimestampSchema,
});
export type StaffMembership = z.infer<typeof StaffMembershipSchema>;

export const StaffInviteRequestSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  email: z.string().trim().toLowerCase().email(),
  role: StaffRoleSchema,
});
export type StaffInviteRequest = z.infer<typeof StaffInviteRequestSchema>;

export const StaffUpdateRequestSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  status: StaffMembershipStatusSchema,
  reason: z.string().trim().min(1).max(2000),
});
export type StaffUpdateRequest = z.infer<typeof StaffUpdateRequestSchema>;

/** What `/v1/me` reports to a signed-in account holder. Admission is derived, never client-claimed. */
export const AdmissionMeSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  user: z.strictObject({
    id: z.string().min(1).max(255),
    email: z.email(),
    name: z.string().max(200),
    emailVerified: z.boolean(),
  }),
  studentId: IdentifierSchema.nullable(),
  enrolment: EnrolmentSchema.nullable(),
  staffRoles: z.array(StaffRoleSchema),
});
export type AdmissionMe = z.infer<typeof AdmissionMeSchema>;

export const StudentProfilePatchSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  expectedVersion: z.number().int().min(1),
  legalName: z.string().trim().min(1).max(200).optional(),
  preferredName: z.string().trim().min(1).max(120).nullable().optional(),
  /** 'suspended' disables the account (sessions revoked); distinct from enrolment suspension. */
  status: z.enum(['active', 'suspended']).optional(),
  reason: z.string().trim().min(1).max(2000),
});
export type StudentProfilePatch = z.infer<typeof StudentProfilePatchSchema>;

export const AdminStudentRowSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  profileId: IdentifierSchema,
  accountUserId: z.string().min(1).max(255).nullable(),
  email: z.email().nullable(),
  emailVerified: z.boolean(),
  legalName: z.string().min(1).max(200),
  preferredName: z.string().min(1).max(120).nullable(),
  status: z.enum(['active', 'suspended']),
  /**
   * Optimistic-concurrency token for `PATCH /v1/admin/students/:id`. The server compares
   * this against `student_profiles.version`, so a client cannot issue a profile update
   * without reading it here first.
   */
  version: z.number().int().min(1),
  enrolment: EnrolmentSchema.nullable(),
  createdAt: TimestampSchema,
});
export type AdminStudentRow = z.infer<typeof AdminStudentRowSchema>;

export const AdminStudentPageSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  rows: z.array(AdminStudentRowSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type AdminStudentPage = z.infer<typeof AdminStudentPageSchema>;

export const ErasureRequestStatusSchema = z.enum(['pending', 'confirmed']);
export type ErasureRequestStatus = z.infer<typeof ErasureRequestStatusSchema>;

export const ErasureRequestSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  studentProfileId: IdentifierSchema,
  status: ErasureRequestStatusSchema,
  requestedAt: TimestampSchema,
  confirmedAt: TimestampSchema.nullable(),
});
export type ErasureRequest = z.infer<typeof ErasureRequestSchema>;
