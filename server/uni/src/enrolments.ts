import { CONTRACT_VERSION, EnrolmentSchema, type Enrolment, type EnrolmentDecisionRequest, type EnrolmentStatus } from '@sef/shared';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './db';
import { recordAuditEvent } from './audit-events';

/** Actions a staff member may take on an enrolment (mirrors EnrolmentDecisionRequestSchema). */
export type EnrolmentAction = EnrolmentDecisionRequest['action'];

export class AdmissionError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_transition' | 'version_conflict' | 'already_enrolled' | 'cohort_required',
    message: string,
  ) {
    super(message);
    this.name = 'AdmissionError';
  }
}

export interface EnrolmentRow {
  id: string;
  student_profile_id: string;
  programme_code: string;
  curriculum_version: string;
  cohort_code: string | null;
  status: EnrolmentStatus;
  version: number;
  requested_at: Date;
  updated_at: Date;
  decision_actor_subject: string | null;
  decision_at: Date | null;
  decision_reason: string | null;
}

export interface StudentProfileRow {
  id: string;
  account_user_id: string | null;
  legal_name: string;
  preferred_name: string | null;
  status: 'active' | 'suspended';
  version: number;
  created_at: Date;
}

export function rowToEnrolment(row: EnrolmentRow): Enrolment {
  return EnrolmentSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    id: row.id,
    studentId: row.student_profile_id,
    programmeId: row.programme_code,
    curriculumVersion: row.curriculum_version,
    cohortId: row.cohort_code,
    status: row.status,
    version: row.version,
    requestedAt: row.requested_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    decision:
      row.decision_at && row.decision_reason && row.decision_actor_subject
        ? { actorId: row.decision_actor_subject, at: row.decision_at.toISOString(), reason: row.decision_reason }
        : null,
  });
}

/**
 * The admission state machine. Rows move only along these edges; a withdraw is a
 * student-initiated action handled by `withdrawEnrolment`, not a staff decision.
 */
const STAFF_TRANSITIONS: Record<EnrolmentStatus, Set<EnrolmentAction>> = {
  pending: new Set(['approve', 'reject']),
  approved: new Set(['suspend', 'assign_cohort']),
  suspended: new Set(['reinstate']),
  rejected: new Set(),
  withdrawn: new Set(),
};

const NEXT_STATUS: Record<EnrolmentAction, EnrolmentStatus> = {
  approve: 'approved',
  reject: 'rejected',
  suspend: 'suspended',
  reinstate: 'approved',
  assign_cohort: 'approved',
};

/** Pure transition check, exported for unit tests. */
export function canDecide(current: EnrolmentStatus, action: EnrolmentAction): boolean {
  return STAFF_TRANSITIONS[current].has(action);
}

const ENROLMENT_COLUMNS = `
  id, student_profile_id, programme_code, curriculum_version, cohort_code, status, version,
  requested_at, updated_at, decision_actor_subject, decision_at, decision_reason`;

async function readProfile(client: PoolClient, profileId: string): Promise<StudentProfileRow | null> {
  const result = await client.query<StudentProfileRow>(
    'SELECT id, account_user_id, legal_name, preferred_name, status, version, created_at FROM student_profiles WHERE id = $1',
    [profileId],
  );
  return result.rows[0] ?? null;
}

export async function profileForUser(client: Pool | PoolClient, accountUserId: string): Promise<StudentProfileRow | null> {
  const result = await client.query<StudentProfileRow>(
    'SELECT id, account_user_id, legal_name, preferred_name, status, version, created_at FROM student_profiles WHERE account_user_id = $1',
    [accountUserId],
  );
  return result.rows[0] ?? null;
}

export async function enrolmentForProfile(client: Pool | PoolClient, profileId: string): Promise<EnrolmentRow | null> {
  const result = await client.query<EnrolmentRow>(
    `SELECT ${ENROLMENT_COLUMNS} FROM enrolments WHERE student_profile_id = $1 ORDER BY requested_at DESC LIMIT 1`,
    [profileId],
  );
  return result.rows[0] ?? null;
}

export async function getEnrolment(client: Pool | PoolClient, id: string): Promise<EnrolmentRow | null> {
  const result = await client.query<EnrolmentRow>(`SELECT ${ENROLMENT_COLUMNS} FROM enrolments WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * Sessions are mirrored in `auth_kv` secondary storage, so revocation must go
 * through the auth adapter. Callers inject `AccountAuth.revokeUserSessions`; it
 * runs on its own connection while the transaction is open, which is safe: a later
 * rollback only leaves the account signed out without a recorded decision.
 */
export type SessionRevoker = (accountUserId: string) => Promise<void>;

const DECISION_EVENT: Record<EnrolmentAction, string> = {
  approve: 'enrolment.approved',
  reject: 'enrolment.rejected',
  suspend: 'enrolment.suspended',
  reinstate: 'enrolment.reinstated',
  assign_cohort: 'enrolment.cohort_assigned',
};

export interface ApplyInput {
  accountUserId: string;
  legalName: string;
  programmeCode: string;
  curriculumVersion: string;
}

/**
 * Idempotent application: a second POST while pending returns the same row; a
 * withdrawn or rejected row is reapplied (status pending, version bumped);
 * approved/suspended enrolments reject with a conflict.
 */
export async function applyForAdmission(pool: Pool, input: ApplyInput): Promise<{ enrolment: Enrolment; reapplied: boolean; created: boolean }> {
  return withTransaction(pool, async (client) => {
    let profile = await profileForUser(client, input.accountUserId);
    if (!profile) {
      const created = await client.query<StudentProfileRow>(
        `INSERT INTO student_profiles (account_user_id, legal_name) VALUES ($1, $2)
         RETURNING id, account_user_id, legal_name, preferred_name, status, version, created_at`,
        [input.accountUserId, input.legalName],
      );
      profile = created.rows[0]!;
      await recordAuditEvent(client, {
        actor: input.accountUserId,
        event: 'application.profile_created',
        subjectType: 'student_profile',
        subjectId: profile.id,
      });
    }
    if (profile.status === 'suspended') throw new AdmissionError('invalid_transition', 'This account is suspended');

    const existing = await client.query<EnrolmentRow>(
      `SELECT ${ENROLMENT_COLUMNS} FROM enrolments WHERE student_profile_id = $1 AND programme_code = $2 FOR UPDATE`,
      [profile.id, input.programmeCode],
    );
    const row = existing.rows[0];

    if (row && (row.status === 'approved' || row.status === 'suspended')) {
      throw new AdmissionError('already_enrolled', 'An active enrolment already exists for this programme');
    }
    if (row && row.status === 'pending') return { enrolment: rowToEnrolment(row), reapplied: false, created: false };

    if (row) {
      const updated = await client.query<EnrolmentRow>(
        `UPDATE enrolments SET status = 'pending', cohort_code = NULL, decision_actor_subject = NULL,
           decision_at = NULL, decision_reason = NULL, requested_at = now(), updated_at = now(), version = version + 1
         WHERE id = $1 RETURNING ${ENROLMENT_COLUMNS}`,
        [row.id],
      );
      await recordAuditEvent(client, {
        actor: input.accountUserId,
        event: 'application.reapplied',
        subjectType: 'enrolment',
        subjectId: row.id,
        details: { programme: input.programmeCode },
      });
      return { enrolment: rowToEnrolment(updated.rows[0]!), reapplied: true, created: false };
    }

    const inserted = await client.query<EnrolmentRow>(
      `INSERT INTO enrolments (student_profile_id, programme_code, curriculum_version, status)
       VALUES ($1, $2, $3, 'pending') RETURNING ${ENROLMENT_COLUMNS}`,
      [profile.id, input.programmeCode, input.curriculumVersion],
    );
    await recordAuditEvent(client, {
      actor: input.accountUserId,
      event: 'application.submitted',
      subjectType: 'enrolment',
      subjectId: inserted.rows[0]!.id,
      details: { programme: input.programmeCode },
    });
    return { enrolment: rowToEnrolment(inserted.rows[0]!), reapplied: false, created: true };
  });
}

/**
 * A staff decision under optimistic concurrency: the row is locked FOR UPDATE, the
 * caller's expectedVersion must still match, and suspension also revokes sessions.
 */
export async function decideEnrolment(
  pool: Pool,
  input: { enrolmentId: string; actor: string; request: EnrolmentDecisionRequest; revokeSessions?: SessionRevoker },
): Promise<Enrolment> {
  const { request } = input;
  return withTransaction(pool, async (client) => {
    const current = await client.query<EnrolmentRow>(
      `SELECT ${ENROLMENT_COLUMNS} FROM enrolments WHERE id = $1 FOR UPDATE`,
      [input.enrolmentId],
    );
    const row = current.rows[0];
    if (!row) throw new AdmissionError('not_found', 'Enrolment not found');
    if (row.version !== request.expectedVersion) {
      throw new AdmissionError('version_conflict', `Enrolment is at version ${row.version}`);
    }
    if (!canDecide(row.status, request.action)) {
      throw new AdmissionError('invalid_transition', `Cannot ${request.action} a ${row.status} enrolment`);
    }
    if ((request.action === 'approve' || request.action === 'assign_cohort') && !request.cohortId) {
      throw new AdmissionError('cohort_required', 'Approval and cohort assignment need a cohort');
    }

    const next = NEXT_STATUS[request.action];
    const cohort = request.action === 'approve' || request.action === 'assign_cohort' ? request.cohortId! : row.cohort_code;
    const updated = await client.query<EnrolmentRow>(
      `UPDATE enrolments SET status = $2, cohort_code = $3, decision_actor_subject = $4,
         decision_at = now(), decision_reason = $5, updated_at = now(), version = version + 1
       WHERE id = $1 RETURNING ${ENROLMENT_COLUMNS}`,
      [input.enrolmentId, next, cohort, input.actor, request.reason],
    );

    if (request.action === 'suspend') {
      const profile = await readProfile(client, row.student_profile_id);
      if (profile?.account_user_id) await input.revokeSessions?.(profile.account_user_id);
    }
    await recordAuditEvent(client, {
      actor: input.actor,
      event: DECISION_EVENT[request.action],
      subjectType: 'enrolment',
      subjectId: row.id,
      details: { from: row.status, to: next, cohort: cohort ?? null },
    });
    return rowToEnrolment(updated.rows[0]!);
  });
}

/** Student-initiated exit: pending, approved and suspended rows can be withdrawn. */
export async function withdrawEnrolment(pool: Pool, accountUserId: string, revokeSessions?: SessionRevoker): Promise<Enrolment> {
  return withTransaction(pool, async (client) => {
    const profile = await profileForUser(client, accountUserId);
    if (!profile) throw new AdmissionError('not_found', 'No student profile for this account');
    const row = await enrolmentForProfile(client, profile.id);
    if (!row) throw new AdmissionError('not_found', 'No enrolment to withdraw');
    if (!['pending', 'approved', 'suspended'].includes(row.status)) {
      throw new AdmissionError('invalid_transition', `A ${row.status} enrolment cannot be withdrawn`);
    }
    const updated = await client.query<EnrolmentRow>(
      `UPDATE enrolments SET status = 'withdrawn', decision_actor_subject = $2, decision_at = now(),
         decision_reason = 'student_withdrawal', updated_at = now(), version = version + 1
       WHERE id = $1 RETURNING ${ENROLMENT_COLUMNS}`,
      [row.id, accountUserId],
    );
    if (row.status === 'approved' || row.status === 'suspended') await revokeSessions?.(accountUserId);
    await recordAuditEvent(client, {
      actor: accountUserId,
      event: 'enrolment.withdrawn',
      subjectType: 'enrolment',
      subjectId: row.id,
      details: { from: row.status },
    });
    return rowToEnrolment(updated.rows[0]!);
  });
}

export interface StudentListQuery {
  search?: string;
  status?: EnrolmentStatus;
  cohort?: string;
  page: number;
  pageSize: number;
}

export interface AdminStudentRowData {
  profile: StudentProfileRow;
  email: string | null;
  emailVerified: boolean;
  enrolment: EnrolmentRow | null;
}

export async function listStudents(pool: Pool, query: StudentListQuery): Promise<{ rows: AdminStudentRowData[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.search) {
    params.push(`%${query.search}%`);
    conditions.push(`(p.legal_name ILIKE $${params.length} OR p.preferred_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (query.status) {
    params.push(query.status);
    conditions.push(`e.status = $${params.length}`);
  }
  if (query.cohort) {
    params.push(query.cohort);
    conditions.push(`e.cohort_code = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM student_profiles p
    LEFT JOIN "user" u ON u.id = p.account_user_id
    LEFT JOIN enrolments e ON e.student_profile_id = p.id`;
  const total = await pool.query<{ n: string }>(`SELECT count(*)::text AS n ${from} ${where}`, params);
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = await pool.query<{
    id: string; account_user_id: string | null; legal_name: string; preferred_name: string | null;
    status: 'active' | 'suspended'; version: number; created_at: Date;
    email: string | null; email_verified: boolean | null;
    e_id: string | null; e_programme_code: string | null; e_curriculum_version: string | null; e_cohort_code: string | null; e_status: EnrolmentStatus | null;
    e_version: number | null; e_requested_at: Date | null; e_updated_at: Date | null;
    e_decision_actor_subject: string | null; e_decision_at: Date | null; e_decision_reason: string | null;
  }>(
    `SELECT p.id, p.account_user_id, p.legal_name, p.preferred_name, p.status, p.version, p.created_at,
       u.email, u."emailVerified" AS email_verified,
       e.id AS e_id, e.programme_code AS e_programme_code, e.curriculum_version AS e_curriculum_version, e.cohort_code AS e_cohort_code, e.status AS e_status,
       e.version AS e_version, e.requested_at AS e_requested_at, e.updated_at AS e_updated_at,
       e.decision_actor_subject AS e_decision_actor_subject, e.decision_at AS e_decision_at, e.decision_reason AS e_decision_reason
     ${from} ${where} ORDER BY p.created_at DESC, p.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    total: Number(total.rows[0]!.n),
    rows: rows.rows.map((row) => ({
      profile: {
        id: row.id, account_user_id: row.account_user_id, legal_name: row.legal_name,
        preferred_name: row.preferred_name, status: row.status, version: row.version, created_at: row.created_at,
      },
      email: row.email,
      emailVerified: row.email_verified ?? false,
      enrolment: row.e_id
        ? {
            id: row.e_id, student_profile_id: row.id, programme_code: row.e_programme_code!,
            curriculum_version: row.e_curriculum_version!, cohort_code: row.e_cohort_code,
            status: row.e_status!, version: row.e_version!, requested_at: row.e_requested_at!, updated_at: row.e_updated_at!,
            decision_actor_subject: row.e_decision_actor_subject,
            decision_at: row.e_decision_at, decision_reason: row.e_decision_reason,
          }
        : null,
    })),
  };
}

export async function getStudentDetail(pool: Pool, profileId: string): Promise<AdminStudentRowData | null> {
  const result = await pool.query<{
    id: string; account_user_id: string | null; legal_name: string; preferred_name: string | null;
    status: 'active' | 'suspended'; version: number; created_at: Date;
    email: string | null; email_verified: boolean | null;
  }>(
    `SELECT p.id, p.account_user_id, p.legal_name, p.preferred_name, p.status, p.version, p.created_at,
       u.email, u."emailVerified" AS email_verified
     FROM student_profiles p LEFT JOIN "user" u ON u.id = p.account_user_id WHERE p.id = $1`,
    [profileId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const enrolment = await enrolmentForProfile(pool, profileId);
  return {
    profile: {
      id: row.id, account_user_id: row.account_user_id, legal_name: row.legal_name,
      preferred_name: row.preferred_name, status: row.status, version: row.version, created_at: row.created_at,
    },
    email: row.email,
    emailVerified: row.email_verified ?? false,
    enrolment,
  };
}

/** Optimistic-versioned profile patch under a row lock; account suspension severs all sessions. */
export async function updateStudentProfile(
  pool: Pool,
  input: { profileId: string; actor: string; legalName?: string; preferredName?: string | null; status?: 'active' | 'suspended'; expectedVersion: number; reason: string; revokeSessions?: SessionRevoker },
): Promise<StudentProfileRow> {
  return withTransaction(pool, async (client) => {
    const current = await client.query<StudentProfileRow>(
      `SELECT id, account_user_id, legal_name, preferred_name, status, version, created_at
       FROM student_profiles WHERE id = $1 FOR UPDATE`,
      [input.profileId],
    );
    const row = current.rows[0];
    if (!row) throw new AdmissionError('not_found', 'Student profile not found');
    if (row.version !== input.expectedVersion) {
      throw new AdmissionError('version_conflict', `Profile is at version ${row.version}`);
    }
    const legalName = input.legalName ?? row.legal_name;
    const preferredName = input.preferredName === undefined ? row.preferred_name : input.preferredName;
    const status = input.status ?? row.status;
    const updated = await client.query<StudentProfileRow>(
      `UPDATE student_profiles SET legal_name = $2, preferred_name = $3, status = $4,
         updated_at = now(), version = version + 1
       WHERE id = $1 RETURNING id, account_user_id, legal_name, preferred_name, status, version, created_at`,
      [input.profileId, legalName, preferredName, status],
    );
    if (status === 'suspended' && row.status !== 'suspended' && row.account_user_id) {
      await input.revokeSessions?.(row.account_user_id);
    }
    await recordAuditEvent(client, {
      actor: input.actor,
      event: 'student_profile.updated',
      subjectType: 'student_profile',
      subjectId: row.id,
      details: { reason: input.reason, statusChanged: status !== row.status ? status : null },
    });
    return updated.rows[0]!;
  });
}

export async function requestErasure(pool: Pool, accountUserId: string): Promise<{ id: string; duplicate: boolean }> {
  return withTransaction(pool, async (client) => {
    const profile = await profileForUser(client, accountUserId);
    if (!profile) throw new AdmissionError('not_found', 'No student profile for this account');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO erasure_requests (student_profile_id) VALUES ($1)
       ON CONFLICT (student_profile_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
      [profile.id],
    );
    const id = inserted.rows[0]?.id;
    if (id) {
      await recordAuditEvent(client, {
        actor: accountUserId, event: 'erasure.requested', subjectType: 'student_profile', subjectId: profile.id,
      });
      return { id, duplicate: false };
    }
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM erasure_requests WHERE student_profile_id = $1 AND status = 'pending'`,
      [profile.id],
    );
    return { id: existing.rows[0]!.id, duplicate: true };
  });
}

export async function listErasureRequests(pool: Pool): Promise<Array<{ id: string; student_profile_id: string; status: string; requested_at: Date; confirmed_at: Date | null }>> {
  const result = await pool.query(
    'SELECT id, student_profile_id, status, requested_at, confirmed_at FROM erasure_requests ORDER BY requested_at DESC LIMIT 200',
  );
  return result.rows;
}

/**
 * Confirmed erasure anonymizes the profile and the auth account (email replaced with a
 * tombstone so the address is released), then destroys sessions and credentials.
 */
export async function confirmErasure(pool: Pool, input: { requestId: string; actor: string; revokeSessions?: SessionRevoker }): Promise<void> {
  await withTransaction(pool, async (client) => {
    const request = await client.query<{ id: string; student_profile_id: string; status: string }>(
      `UPDATE erasure_requests SET status = 'confirmed', confirmed_at = now(), confirmed_by_subject = $2
       WHERE id = $1 AND status = 'pending' RETURNING id, student_profile_id, status`,
      [input.requestId, input.actor],
    );
    const row = request.rows[0];
    if (!row) throw new AdmissionError('not_found', 'No pending erasure request with that id');

    const profile = await readProfile(client, row.student_profile_id);
    if (!profile) throw new AdmissionError('not_found', 'Student profile not found');
    await client.query(
      `UPDATE student_profiles SET legal_name = '[erased]', preferred_name = NULL, updated_at = now(), version = version + 1 WHERE id = $1`,
      [profile.id],
    );
    if (profile.account_user_id) {
      await client.query(`UPDATE "user" SET email = $2, name = '[erased]', "emailVerified" = false WHERE id = $1`, [
        profile.account_user_id,
        `erased-${profile.id}@erased.invalid`,
      ]);
      await input.revokeSessions?.(profile.account_user_id);
      await client.query('DELETE FROM account WHERE "userId" = $1', [profile.account_user_id]);
      await client.query('DELETE FROM "twoFactor" WHERE "userId" = $1', [profile.account_user_id]);
    }
    await recordAuditEvent(client, {
      actor: input.actor,
      event: 'erasure.confirmed',
      subjectType: 'student_profile',
      subjectId: profile.id,
      details: { requestId: row.id },
    });
  });
}
