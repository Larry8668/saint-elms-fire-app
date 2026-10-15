import { CONTRACT_VERSION, type InstitutionalRole, type StaffMembership, type StaffRole } from '@sef/shared';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './db';
import { recordAuditEvent } from './audit-events';
import { AdmissionError, type SessionRevoker } from './enrolments';

export interface StaffMembershipRow {
  id: string;
  staff_subject: string;
  institution_code: string;
  display_name: string;
  role: StaffRole;
  status: 'active' | 'suspended' | 'ended';
  version: number;
  created_at: Date;
}

const ROLE_MAP: Record<StaffRole, InstitutionalRole> = {
  owner: 'university_owner',
  registrar: 'university_admin',
  lecturer: 'university_admin',
  support: 'university_admin',
};

export function rowToMembership(row: StaffMembershipRow): StaffMembership {
  return {
    schemaVersion: CONTRACT_VERSION,
    id: row.id,
    subject: row.staff_subject,
    displayName: row.display_name,
    role: row.role,
    institutionalRole: ROLE_MAP[row.role],
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export async function membershipsForSubject(client: Pool | PoolClient, subject: string): Promise<StaffMembershipRow[]> {
  const result = await client.query<StaffMembershipRow>(
    `SELECT id, staff_subject, institution_code, display_name, role, status, version, created_at
     FROM staff_memberships WHERE staff_subject = $1 ORDER BY created_at`,
    [subject],
  );
  return result.rows;
}

/** Active staff roles for one account; empty array means the account is not staff. */
export async function activeStaffRoles(client: Pool | PoolClient, subject: string): Promise<StaffRole[]> {
  const rows = await membershipsForSubject(client, subject);
  return rows.filter((row) => row.status === 'active').map((row) => row.role);
}

export async function getStaffMembership(client: Pool | PoolClient, id: string): Promise<StaffMembershipRow | null> {
  const result = await client.query<StaffMembershipRow>(
    `SELECT id, staff_subject, institution_code, display_name, role, status, version, created_at
     FROM staff_memberships WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listStaff(pool: Pool): Promise<StaffMembershipRow[]> {
  const result = await pool.query<StaffMembershipRow>(
    `SELECT id, staff_subject, institution_code, display_name, role, status, version, created_at
     FROM staff_memberships ORDER BY created_at DESC LIMIT 500`,
  );
  return result.rows;
}

/**
 * Grants a staff membership to an already-registered, email-verified account.
 * Callers gate who may grant which role; this layer just records the grant.
 */
export async function grantStaffMembership(
  pool: Pool,
  input: { email: string; role: StaffRole; actor: string },
): Promise<StaffMembershipRow> {
  return withTransaction(pool, async (client) => {
    const user = await client.query<{ id: string; name: string; emailVerified: boolean }>(
      'SELECT id, name, "emailVerified" FROM "user" WHERE lower(email) = lower($1)',
      [input.email],
    );
    const account = user.rows[0];
    if (!account) throw new AdmissionError('not_found', 'No verified account exists for that email');
    if (!account.emailVerified) throw new AdmissionError('invalid_transition', 'Staff must hold a verified account');
    const inserted = await client.query<StaffMembershipRow>(
      `INSERT INTO staff_memberships (staff_subject, display_name, role)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT staff_memberships_subject_institution_unique DO NOTHING
       RETURNING id, staff_subject, institution_code, display_name, role, status, version, created_at`,
      [account.id, account.name, input.role],
    );
    const row = inserted.rows[0];
    if (!row) throw new AdmissionError('already_enrolled', 'A staff membership already exists for that account');
    await recordAuditEvent(client, {
      actor: input.actor,
      event: 'staff.granted',
      subjectType: 'staff_membership',
      subjectId: row.id,
      details: { role: input.role, subject: account.id },
    });
    return row;
  });
}

/**
 * Suspends, reinstates or ends a membership. The last active owner can never lose
 * their role, and removing a membership severs that account's sessions.
 */
export async function updateStaffStatus(
  pool: Pool,
  input: { membershipId: string; status: 'active' | 'suspended' | 'ended'; reason: string; actor: string; revokeSessions?: SessionRevoker },
): Promise<StaffMembershipRow> {
  return withTransaction(pool, async (client) => {
    const rows = await client.query<StaffMembershipRow>(
      `SELECT id, staff_subject, institution_code, display_name, role, status, version, created_at
       FROM staff_memberships WHERE id = $1 FOR UPDATE`,
      [input.membershipId],
    );
    const row = rows.rows[0];
    if (!row) throw new AdmissionError('not_found', 'Staff membership not found');
    if (row.status === input.status) return row;
    if (row.status === 'ended') throw new AdmissionError('invalid_transition', 'An ended membership cannot change');

    if (row.role === 'owner' && row.status === 'active' && input.status !== 'active') {
      const owners = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM staff_memberships WHERE role = 'owner' AND status = 'active' AND id <> $1`,
        [row.id],
      );
      if (Number(owners.rows[0]!.n) === 0) {
        throw new AdmissionError('invalid_transition', 'The last active owner cannot be removed');
      }
    }

    const updated = await client.query<StaffMembershipRow>(
      `UPDATE staff_memberships SET status = $2, updated_at = now(), version = version + 1
       WHERE id = $1 RETURNING id, staff_subject, institution_code, display_name, role, status, version, created_at`,
      [row.id, input.status],
    );
    if (input.status !== 'active') {
      await input.revokeSessions?.(row.staff_subject);
    }
    await recordAuditEvent(client, {
      actor: input.actor,
      event: `staff.${input.status === 'active' ? 'reinstated' : input.status === 'suspended' ? 'suspended' : 'ended'}`,
      subjectType: 'staff_membership',
      subjectId: row.id,
      details: { reason: input.reason },
    });
    return updated.rows[0]!;
  });
}
