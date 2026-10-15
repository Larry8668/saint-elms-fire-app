import {
  AdmissionMeSchema,
  AdminStudentPageSchema,
  AdminStudentRowSchema,
  CONTRACT_VERSION,
  EnrolmentDecisionRequestSchema,
  EnrolmentSchema,
  ErasureRequestSchema,
  StaffInviteRequestSchema,
  StaffMembershipSchema,
  StaffUpdateRequestSchema,
  StudentProfilePatchSchema,
  type AdmissionMe,
  type AdminStudentPage,
  type AdminStudentRow,
  type Enrolment,
  type EnrolmentDecisionRequest,
  type ErasureRequest,
  type StaffInviteRequest,
  type StaffMembership,
  type StaffUpdateRequest,
  type StudentProfilePatch,
} from '@sef/shared';
import { readAuditEvents, readCohorts, type AuditEvent, type Cohort } from './guards';
import { API_BASE, ApiError, contractError, getJson, sendJson } from './http';

/**
 * The staff API under `/v1/admin`. Every response is parsed with the shared contract before it
 * reaches a view, and every request body is validated with the same contract before it is sent:
 * a drifted shape fails here instead of rendering a plausible wrong record.
 */

const ADMIN = `${API_BASE}/admin`;

/** The structural shape of a zod schema, so contracts are consumed without re-implementing them. */
type Reader<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };
type Writer<T> = { parse: (value: unknown) => T };

/** Client-side contract check. A request this app cannot describe is never put on the wire. */
function outgoing<T>(schema: Writer<T> & Reader<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('This app could not build a valid request.', 0, 'invalid_request');
  return parsed.data;
}

function incoming<T>(schema: Reader<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw contractError(what);
  return parsed.data;
}

/** Admission record for the signed-in account. Staff roles here are the authority for the UI. */
export async function fetchMe(): Promise<AdmissionMe> {
  return incoming(AdmissionMeSchema, await getJson(`${API_BASE}/me`), 'an admission record');
}

export interface StudentQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  cohort?: string;
}

export async function listStudents(query: StudentQuery): Promise<AdminStudentPage> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.search) params.set('search', query.search);
  if (query.status) params.set('status', query.status);
  if (query.cohort) params.set('cohort', query.cohort);
  return incoming(AdminStudentPageSchema, await getJson(`${ADMIN}/students?${params}`), 'a student list');
}

export interface StudentDetail {
  row: AdminStudentRow;
  /**
   * The profile's optimistic-lock version, which `PATCH /students/:id` compares against —
   * the row's `version` field, surfaced separately so the view cannot drop it by accident.
   */
  profileVersion: number | null;
}

export async function getStudent(profileId: string): Promise<StudentDetail> {
  const row = incoming(AdminStudentRowSchema, await getJson(`${ADMIN}/students/${encodeURIComponent(profileId)}`), 'a student record');
  return { row, profileVersion: row.version };
}

/** Profile maintenance: names and account status. `expectedVersion` is the optimistic guard. */
export async function patchStudent(profileId: string, patch: Omit<StudentProfilePatch, 'schemaVersion'>): Promise<AdminStudentRow> {
  const body = outgoing(StudentProfilePatchSchema, { schemaVersion: CONTRACT_VERSION, ...patch });
  return incoming(
    AdminStudentRowSchema,
    await sendJson(`${ADMIN}/students/${encodeURIComponent(profileId)}`, 'PATCH', body),
    'a student record',
  );
}

/** Admission decision. `expectedVersion` must be the version this view last read. */
export async function decideEnrolment(
  enrolmentId: string,
  request: Omit<EnrolmentDecisionRequest, 'schemaVersion'>,
): Promise<Enrolment> {
  const body = outgoing(EnrolmentDecisionRequestSchema, { schemaVersion: CONTRACT_VERSION, ...request });
  return incoming(
    EnrolmentSchema,
    await sendJson(`${ADMIN}/enrolments/${encodeURIComponent(enrolmentId)}/decision`, 'POST', body),
    'an enrolment record',
  );
}

/** Relays a recovery email to the student's own mailbox. 202 means accepted, not delivered. */
export async function sendRecoveryEmail(profileId: string): Promise<void> {
  await sendJson(`${ADMIN}/students/${encodeURIComponent(profileId)}/recovery-email`, 'POST', {});
}

export async function listStaff(): Promise<StaffMembership[]> {
  const raw = await getJson(`${ADMIN}/staff`);
  if (!Array.isArray(raw)) throw contractError('a staff list');
  return raw.map((entry, index) => incoming(StaffMembershipSchema, entry, `staff membership #${index + 1}`));
}

export async function inviteStaff(request: Omit<StaffInviteRequest, 'schemaVersion'>): Promise<StaffMembership> {
  const body = outgoing(StaffInviteRequestSchema, { schemaVersion: CONTRACT_VERSION, ...request });
  return incoming(StaffMembershipSchema, await sendJson(`${ADMIN}/staff`, 'POST', body), 'a staff membership');
}

export async function updateStaff(
  membershipId: string,
  request: Omit<StaffUpdateRequest, 'schemaVersion'>,
): Promise<StaffMembership> {
  const body = outgoing(StaffUpdateRequestSchema, { schemaVersion: CONTRACT_VERSION, ...request });
  return incoming(
    StaffMembershipSchema,
    await sendJson(`${ADMIN}/staff/${encodeURIComponent(membershipId)}`, 'PATCH', body),
    'a staff membership',
  );
}

export async function listErasureRequests(): Promise<ErasureRequest[]> {
  const raw = await getJson(`${ADMIN}/erasure-requests`);
  if (!Array.isArray(raw)) throw contractError('an erasure request list');
  return raw.map((entry, index) => incoming(ErasureRequestSchema, entry, `erasure request #${index + 1}`));
}

/** Irreversible: deletes the student's profile and account. Owner-only and freshly authenticated. */
export async function confirmErasure(requestId: string): Promise<void> {
  await sendJson(`${ADMIN}/erasure-requests/${encodeURIComponent(requestId)}/confirm`, 'POST', {});
}

export async function listAuditEvents(limit = 100): Promise<AuditEvent[]> {
  const events = readAuditEvents(await getJson(`${ADMIN}/audit-events?limit=${limit}`));
  if (!events) throw contractError('an audit history');
  return events;
}

/** Published cohorts, for the approval and cohort-correction pickers. */
export async function listCohorts(): Promise<Cohort[]> {
  const cohorts = readCohorts(await getJson(`${API_BASE}/cohorts`));
  if (!cohorts) throw contractError('a cohort list');
  return cohorts;
}