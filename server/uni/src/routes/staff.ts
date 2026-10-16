import { Hono } from 'hono';
import {
  CONTRACT_VERSION,
  EnrolmentDecisionRequestSchema,
  RemoveShareRequestSchema,
  StaffInviteRequestSchema,
  StaffUpdateRequestSchema,
  StudentProfilePatchSchema,
  type AdminShareDetail,
  type AdminSharePage,
  type AdminStudentPage,
  type AdminStudentRow,
  type ErasureRequest,
  type LegacySharePage,
} from '@sef/shared';
import { TokenError, verifyToken } from '@sef/shared/node';
import { requireAdmission, type AppEnv } from '../authorization';
import { recentAuditEvents } from '../audit-events';
import type { UniDeps } from '../deps';
import { log } from '../logger';
import {
  decodeShareCursor,
  getPublishedShare,
  listShareEvents,
  listSharesForModeration,
  removeShare,
  rowToAdminShareView,
  rowToPublishedShare,
  ShareError,
} from '../shares';

import { shareErrorStatus } from './shares';
import {
  AdmissionError,
  confirmErasure,
  decideEnrolment,
  getStudentDetail,
  listErasureRequests,
  listStudents,
  rowToEnrolment,
  updateStudentProfile,
  type AdminStudentRowData,
  type StudentListQuery,
} from '../enrolments';
import { getStaffMembership, grantStaffMembership, listStaff, rowToMembership, updateStaffStatus } from '../staff';
import { admissionErrorStatus } from './me';

/** Sensitive staff mutations need a session created within the last 30 minutes. */
const FRESH_MINUTES = 30;
const MUTATION = { staff: 'any' as const, maxSessionAgeMinutes: FRESH_MINUTES };
/** Staff membership administration is owner-only; the session must also be fresh. */
const OWNER_MUTATION = { staff: 'owner' as const, maxSessionAgeMinutes: FRESH_MINUTES };

function toRow(data: AdminStudentRowData): AdminStudentRow {
  return {
    schemaVersion: CONTRACT_VERSION,
    profileId: data.profile.id,
    accountUserId: data.profile.account_user_id,
    email: data.email,
    emailVerified: data.emailVerified,
    legalName: data.profile.legal_name,
    preferredName: data.profile.preferred_name,
    status: data.profile.status,
    version: data.profile.version,
    enrolment: data.enrolment ? rowToEnrolment(data.enrolment) : null,
    createdAt: data.profile.created_at.toISOString(),
  };
}

function admissionError(error: unknown, c: { json: (body: unknown, status?: number) => Response }) {
  if (error instanceof AdmissionError) {
    return c.json({ error: error.code, message: error.message }, admissionErrorStatus(error.code));
  }
  throw error;
}

/**
 * Registrar/staff administration of students, enrolments, staff and erasure.
 * Distinct from the legacy-token admin surface: every caller is a verified staff
 * session, mutations require a fresh session, and actors are subject ids.
 */
export function staffRoutes(deps: UniDeps) {
  const app = new Hono<AppEnv>();
  // adminRoutes shares this prefix and claims sef1 bearer tokens; session
  // requests (cookie or better-auth bearer) are the admission domain. A sef1
  // token still has to verify and carry the admin role — a student token must
  // not read the roster, staff list, erasure queue or audit trail below.
  app.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token?.startsWith('sef1')) {
      try {
        const claims = verifyToken(token, deps.keys.publicKeyPem);
        if (claims.role !== 'admin') {
          log.warn('staff_forbidden_legacy_role', { sub: claims.sub, role: claims.role, path: c.req.path });
          return c.json({ error: 'forbidden' }, 403);
        }
        c.set('claims', claims);
        return next();
      } catch (error) {
        if (error instanceof TokenError) return c.json({ error: 'unauthenticated' }, 401);
        throw error;
      }
    }
    return requireAdmission(deps, { staff: 'any' })(c, next);
  });
  const actor = (c: { get: (k: 'principal') => { userId: string } }) => c.get('principal').userId;

  app.get('/students', async (c) => {
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize')) || 25));
    const query: StudentListQuery = {
      search: c.req.query('search')?.trim() || undefined,
      status: (c.req.query('status') as StudentListQuery['status']) || undefined,
      cohort: c.req.query('cohort') || undefined,
      page,
      pageSize,
    };
    const { rows, total } = await listStudents(deps.pool!, query);
    const body: AdminStudentPage = { schemaVersion: CONTRACT_VERSION, rows: rows.map(toRow), total, page, pageSize };
    return c.json(body);
  });

  app.get('/students/:id', async (c) => {
    const detail = await getStudentDetail(deps.pool!, c.req.param('id'));
    if (!detail) return c.json({ error: 'not_found' }, 404);
    return c.json(toRow(detail));
  });

  app.patch('/students/:id', requireAdmission(deps, MUTATION), async (c) => {
    const parsed = StudentProfilePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    try {
      const row = await updateStudentProfile(deps.pool!, {
        profileId: c.req.param('id'),
        actor: actor(c),
        legalName: parsed.data.legalName,
        preferredName: parsed.data.preferredName,
        status: parsed.data.status,
        expectedVersion: parsed.data.expectedVersion,
        reason: parsed.data.reason,
        revokeSessions: deps.accountAuth?.revokeUserSessions,
      });
      const detail = await getStudentDetail(deps.pool!, row.id);
      return c.json(toRow(detail!));
    } catch (error) {
      return admissionError(error, c);
    }
  });

  app.post('/enrolments/:id/decision', requireAdmission(deps, MUTATION), async (c) => {
    const parsed = EnrolmentDecisionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    if (parsed.data.cohortId && !deps.releases.has(parsed.data.cohortId)) {
      return c.json({ error: 'unknown_cohort' }, 400);
    }
    try {
      const enrolment = await decideEnrolment(deps.pool!, {
        enrolmentId: c.req.param('id'),
        actor: actor(c),
        request: parsed.data,
        revokeSessions: deps.accountAuth?.revokeUserSessions,
      });
      return c.json(enrolment);
    } catch (error) {
      return admissionError(error, c);
    }
  });

  app.get('/staff', async (c) => {
    const rows = await listStaff(deps.pool!);
    return c.json(rows.map(rowToMembership));
  });

  app.post('/staff', requireAdmission(deps, OWNER_MUTATION), async (c) => {
    const parsed = StaffInviteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    try {
      const membership = await grantStaffMembership(deps.pool!, {
        email: parsed.data.email,
        role: parsed.data.role,
        actor: actor(c),
      });
      return c.json(rowToMembership(membership), 201);
    } catch (error) {
      return admissionError(error, c);
    }
  });

  app.patch('/staff/:id', requireAdmission(deps, OWNER_MUTATION), async (c) => {
    const parsed = StaffUpdateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    const target = await getStaffMembership(deps.pool!, c.req.param('id'));
    if (!target) return c.json({ error: 'not_found' }, 404);
    try {
      const membership = await updateStaffStatus(deps.pool!, {
        membershipId: target.id,
        status: parsed.data.status,
        reason: parsed.data.reason,
        actor: actor(c),
        revokeSessions: deps.accountAuth?.revokeUserSessions,
      });
      return c.json(rowToMembership(membership));
    } catch (error) {
      return admissionError(error, c);
    }
  });

  app.post('/students/:id/recovery-email', requireAdmission(deps, MUTATION), async (c) => {
    const detail = await getStudentDetail(deps.pool!, c.req.param('id'));
    if (!detail?.email) return c.json({ error: 'not_found' }, 404);
    // Relay through the real auth endpoint: the link goes to the student's mailbox,
    // never to the admin, and rate limits still apply.
    const response = await deps.accountAuth!.handler(
      new Request(new URL('/v1/auth/request-password-reset', deps.accountAuth!.trustedOrigins[0]), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: deps.accountAuth!.trustedOrigins[0] },
        body: JSON.stringify({ email: detail.email }),
      }),
    );
    if (!response.ok) return c.json({ error: 'recovery_unavailable' }, 502);
    return c.body(null, 202);
  });

  app.get('/erasure-requests', async (c) => {
    const rows = await listErasureRequests(deps.pool!);
    const body: ErasureRequest[] = rows.map((row) => ({
      schemaVersion: CONTRACT_VERSION,
      id: row.id,
      studentProfileId: row.student_profile_id,
      status: row.status as ErasureRequest['status'],
      requestedAt: row.requested_at.toISOString(),
      confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
    }));
    return c.json(body);
  });

  app.post('/erasure-requests/:id/confirm', requireAdmission(deps, OWNER_MUTATION), async (c) => {
    try {
      await confirmErasure(deps.pool!, {
        requestId: c.req.param('id'),
        actor: actor(c),
        revokeSessions: deps.accountAuth?.revokeUserSessions,
      });
      return c.body(null, 204);
    } catch (error) {
      return admissionError(error, c);
    }
  });

  app.get('/audit-events', async (c) => {
    const rows = await recentAuditEvents(deps.pool!, Number(c.req.query('limit') ?? 100));
    return c.json(rows.map((row) => ({
      id: row.id,
      actor: row.actor_subject,
      event: row.event_type,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      details: row.details,
      at: row.occurred_at.toISOString(),
    })));
  });

  // Share moderation: staff see every share in every cohort and state; students
  // only ever reach the cohort-scoped feed in routes/shares.ts.
  app.get('/published-shares', async (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 25));
    const state = c.req.query('state');
    if (state !== undefined && state !== 'published' && state !== 'withdrawn') {
      return c.json({ error: 'invalid_state' }, 400);
    }
    let cursor = null;
    try {
      cursor = decodeShareCursor(c.req.query('cursor'));
    } catch (error) {
      if (error instanceof ShareError) return c.json({ error: error.code }, 400);
      throw error;
    }
    const { rows, nextCursor } = await listSharesForModeration(deps.pool!, {
      cohortCode: c.req.query('cohort') || undefined,
      state,
      cursor,
      limit,
    });
    const body: AdminSharePage = {
      schemaVersion: CONTRACT_VERSION,
      items: rows.map(rowToAdminShareView),
      nextCursor,
    };
    return c.json(body);
  });

  app.get('/published-shares/:id', async (c) => {
    const share = await getPublishedShare(deps.pool!, c.req.param('id'));
    if (!share) return c.json({ error: 'not_found' }, 404);
    const events = await listShareEvents(deps.pool!, share.id);
    const body: AdminShareDetail = {
      ...rowToPublishedShare(share),
      lastModeration: events.at(-1) ?? null,
      events,
    };
    return c.json(body);
  });

  app.post('/published-shares/:id/remove', requireAdmission(deps, MUTATION), async (c) => {
    const parsed = RemoveShareRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    try {
      const row = await removeShare(deps.pool!, {
        shareId: c.req.param('id'),
        actor: actor(c),
        note: parsed.data.note ?? null,
      });
      log.info('share_removed_by_staff', { cohortId: row.cohort_code });
      return c.json(rowToPublishedShare(row));
    } catch (error) {
      if (error instanceof ShareError) return c.json({ error: error.code }, shareErrorStatus(error.code));
      throw error;
    }
  });

  // The quarantined pre-admission relay: readable for review and eventual
  // explicit migration, but its items are never merged into the new surface.
  app.get('/legacy-shares', async (c) => {
    const body: LegacySharePage = {
      schemaVersion: CONTRACT_VERSION,
      quarantined: true,
      items: deps.shares.all().map(({ image: _image, fromAccountId: _id, ...share }) => share),
    };
    return c.json(body);
  });

  return app;
}
