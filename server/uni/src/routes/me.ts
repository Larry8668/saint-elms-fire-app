import { Hono } from 'hono';
import {
  CONTRACT_VERSION,
  ENGINE_AUDIENCE,
  EnrolmentApplicationSchema,
  EntitlementRequestSchema,
  type AdmissionMe,
  type EntitlementResponse,
  type TokenClaims,
} from '@sef/shared';
import { signToken } from '@sef/shared/node';
import { requireAdmission, requireSession, type AppEnv } from '../authorization';
import { config } from '../config';
import type { UniDeps } from '../deps';
import { AdmissionError, applyForAdmission, enrolmentForProfile, profileForUser, requestErasure, rowToEnrolment, withdrawEnrolment } from '../enrolments';
import { activeStaffRoles } from '../staff';

export function admissionErrorStatus(code: AdmissionError['code']): 400 | 404 | 409 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'cohort_required':
      return 400;
    default:
      return 409;
  }
}

/**
 * The student's own admission surface: identity, application state, withdraw and
 * erasure. Everything here is derived server-side from the session — a client can
 * never assert an admission status.
 */
export function meRoutes(deps: UniDeps) {
  const app = new Hono<AppEnv>();
  // Per-route, not app.use: a '*' middleware mounted under /v1 would intercept the
  // sibling routers' paths too.
  const session = requireSession(deps);

  app.get('/me', session, async (c) => {
    const principal = c.get('principal');
    const profile = await profileForUser(deps.pool!, principal.userId);
    const enrolment = profile ? await enrolmentForProfile(deps.pool!, profile.id) : null;
    const roles = await activeStaffRoles(deps.pool!, principal.userId);
    const body: AdmissionMe = {
      schemaVersion: CONTRACT_VERSION,
      user: { id: principal.userId, email: principal.email, name: principal.name, emailVerified: principal.emailVerified },
      studentId: profile?.id ?? null,
      enrolment: enrolment ? rowToEnrolment(enrolment) : null,
      staffRoles: roles,
    };
    return c.json(body);
  });

  app.post('/applications', session, async (c) => {
    const principal = c.get('principal');
    if (!principal.emailVerified) return c.json({ error: 'verification_required' }, 403);
    const parsed = EnrolmentApplicationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    const programme = deps.programme?.programme;
    if (!programme) return c.json({ error: 'programme_unavailable' }, 503);
    if (parsed.data.programmeId !== programme.id) return c.json({ error: 'unknown_programme' }, 400);
    try {
      const result = await applyForAdmission(deps.pool!, {
        accountUserId: principal.userId,
        legalName: principal.name,
        programmeCode: programme.id,
        curriculumVersion: programme.manifestVersion,
      });
      return c.json(result.enrolment, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof AdmissionError) return c.json({ error: error.code, message: error.message }, admissionErrorStatus(error.code));
      throw error;
    }
  });

  app.post('/me/enrolment/withdraw', session, async (c) => {
    try {
      const enrolment = await withdrawEnrolment(deps.pool!, c.get('principal').userId, deps.accountAuth?.revokeUserSessions);
      return c.json(enrolment);
    } catch (error) {
      if (error instanceof AdmissionError) return c.json({ error: error.code, message: error.message }, admissionErrorStatus(error.code));
      throw error;
    }
  });

  app.post('/me/erasure-requests', session, async (c) => {
    try {
      const result = await requestErasure(deps.pool!, c.get('principal').userId);
      return c.json({ id: result.id, status: 'pending' }, result.duplicate ? 200 : 201);
    } catch (error) {
      if (error instanceof AdmissionError) return c.json({ error: error.code, message: error.message }, admissionErrorStatus(error.code));
      throw error;
    }
  });

  /**
   * Device-bound offline entitlement: a signed credential the engine verifies locally
   * (signature, audience, student, device, cohort, expiry) so approved study can
   * continue while the university is unreachable. It never authorizes staff APIs —
   * every admission/staff route still demands a live session.
   */
  app.post('/entitlement', requireAdmission(deps, { approved: true }), async (c) => {
    const parsed = EntitlementRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    const cohortId = c.get('admission').enrolment?.cohort_code;
    if (!cohortId) return c.json({ error: 'unapproved', message: 'Enrolment has no cohort' }, 403);
    const principal = c.get('principal');
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + config.entitlementHours * 3600;
    const claims: TokenClaims = {
      iss: config.issuer,
      sub: principal.userId,
      role: 'student',
      name: principal.name,
      email: principal.email,
      cohortId,
      aud: ENGINE_AUDIENCE,
      dev: parsed.data.deviceId,
      iat,
      exp,
    };
    const body: EntitlementResponse = {
      token: signToken(claims, deps.keys.privateKey),
      expiresAt: new Date(exp * 1000).toISOString(),
      cohortId,
    };
    return c.json(body);
  });

  return app;
}
