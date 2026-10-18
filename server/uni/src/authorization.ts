import type { MiddlewareHandler } from 'hono';
import type { TokenClaims } from '@sef/shared';
import { TokenError, verifyToken } from '@sef/shared/node';
import type { UniDeps } from './deps';
import { enrolmentForProfile, profileForUser, type StudentProfileRow } from './enrolments';
import type { EnrolmentRow } from './enrolments';
import { activeStaffRoles } from './staff';
import { config } from './config';
import { demoPersonaForClaims, demoProfileId } from './demo-admission';
import { log } from './logger';
import type { SigningKeys } from './signing';

/** A live better-auth session resolved to its account row. */
export interface SessionPrincipal {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  sessionId: string;
  sessionCreatedAt: Date | null;
}

/** Admission state resolved for a session holder; `profile` is null until they apply. */
export interface Admission {
  profile: StudentProfileRow | null;
  enrolment: EnrolmentRow | null;
  staffRoles: string[];
}

export type AppEnv = {
  Variables: {
    claims: TokenClaims;
    principal: SessionPrincipal;
    admission: Admission;
    accessor: { kind: 'legacy'; claims: TokenClaims } | { kind: 'session'; principal: SessionPrincipal; admission: Admission };
  };
};

const bearer = (authorization: string | undefined) => authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

/** Legacy signed student/admin tokens share the `sef1` prefix; everything else may be a session. */
export async function resolvePrincipal(deps: UniDeps, request: Request): Promise<SessionPrincipal | null> {
  if (!deps.accountAuth) return null;
  try {
    const session = await deps.accountAuth.getSession(request.headers);
    if (!session?.user?.id) return null;
    return {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      emailVerified: Boolean(session.user.emailVerified),
      sessionId: session.session?.id ?? '',
      sessionCreatedAt: session.session?.createdAt ? new Date(session.session.createdAt) : null,
    };
  } catch {
    return null;
  }
}

function tryLegacyClaims(keys: SigningKeys, request: Request): TokenClaims | null {
  const token = bearer(request.headers.get('authorization') ?? undefined);
  if (!token || !token.startsWith('sef1')) return null;
  try {
    return verifyToken(token, keys.publicKeyPem);
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    return null;
  }
}

const unavailable = (c: { json: (body: unknown, status: number) => Response }) =>
  c.json({ error: 'admission_unavailable' }, 503);

/** Requires a database-backed account session. Sets `principal`. */
export function requireSession(deps: UniDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!deps.accountAuth || !deps.pool) return unavailable(c);
    const principal = await resolvePrincipal(deps, c.req.raw);
    if (!principal) return c.json({ error: 'unauthenticated' }, 401);
    c.set('principal', principal);
    await next();
  };
}

/**
 * Resolves the caller's live admission row. `requireApproved` additionally demands an
 * approved enrolment; `requireStaff(capability)` demands an active membership
 * ('owner' restricts to university owners). Mutating staff routes should pass
 * `maxSessionAgeMinutes` so sensitive decisions need a recently-authenticated session.
 */
export function requireAdmission(
  deps: UniDeps,
  options: { approved?: boolean; staff?: 'any' | 'owner'; maxSessionAgeMinutes?: number; demoLegacy?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!deps.accountAuth || !deps.pool) return unavailable(c);
    const { approved = false, staff, maxSessionAgeMinutes, demoLegacy = false } = options;
    const pool = deps.pool;

    const demo = demoLegacy && approved && !staff ? await resolveDemoPrincipal(deps, c.req.raw) : null;
    const principal = demo?.principal ?? (await resolvePrincipal(deps, c.req.raw));
    if (!principal) return c.json({ error: 'unauthenticated' }, 401);

    const profile = demo ? demo.profile : await profileForUser(pool, principal.userId);
    const enrolment = profile ? await enrolmentForProfile(pool, profile.id) : null;
    const staffRoles = demo ? [] : await activeStaffRoles(pool, principal.userId);
    const admission: Admission = { profile, enrolment, staffRoles };
    c.set('admission', admission);

    if (staff) {
      if (staffRoles.length === 0) return c.json({ error: 'forbidden' }, 403);
      if (staff === 'owner' && !staffRoles.includes('owner')) return c.json({ error: 'forbidden' }, 403);
      if (maxSessionAgeMinutes !== undefined) {
        // The session object can come from secondary-storage cache, so freshness is
        // checked against the database mirror — and a session with no row is stale.
        const row = await pool.query<{ createdAt: Date }>('SELECT "createdAt" FROM session WHERE id = $1', [principal.sessionId]);
        const createdAt = row.rows[0]?.createdAt;
        const age = createdAt ? Date.now() - createdAt.getTime() : Infinity;
        if (age > maxSessionAgeMinutes * 60_000) return c.json({ error: 'reauthentication_required' }, 403);
      }
    }
    if (approved) {
      if (!principal.emailVerified) return c.json({ error: 'verification_required' }, 403);
      if (!profile) return c.json({ error: 'unapproved', message: 'No application on file' }, 403);
      if (profile.status !== 'active') return c.json({ error: 'unapproved', message: 'Account suspended' }, 403);
      if (enrolment?.status !== 'approved' || !enrolment.cohort_code) {
        return c.json({ error: 'unapproved', message: 'Enrolment is not approved' }, 403);
      }
    }
    c.set('principal', principal);
    await next();
  };
}

/**
 * A legacy sef1 token held by a SEED_DEMO persona, resolved to that persona's seeded,
 * unlinked admission profile (see demo-admission.ts). Null — and the caller falls back to
 * the session path, which refuses legacy tokens — unless demo seeding is on, the token is
 * a student token whose subject and email match a live persona account, and the
 * persona's profile row exists. The token can only ever act as its own persona.
 */
async function resolveDemoPrincipal(
  deps: UniDeps,
  request: Request,
): Promise<{ principal: SessionPrincipal; profile: StudentProfileRow } | null> {
  if (!(deps.seedDemo ?? config.seedDemo) || !deps.pool) return null;
  const claims = tryLegacyClaims(deps.keys, request);
  if (!claims) return null;
  const persona = demoPersonaForClaims(claims, (id, email) => {
    const account = deps.accounts?.get(id);
    return Boolean(account && !account.disabled && account.role === 'student' && account.email.toLowerCase() === email.toLowerCase());
  });
  if (!persona) return null;
  const rows = await deps.pool.query<StudentProfileRow>(
    `SELECT id, account_user_id, legal_name, preferred_name, status, version, created_at
     FROM student_profiles WHERE id = $1 AND account_user_id IS NULL`,
    [demoProfileId(persona.id)],
  );
  const profile = rows.rows[0];
  if (!profile) return null;
  return {
    principal: {
      userId: `demo:${persona.id}`,
      email: persona.email,
      name: persona.name,
      emailVerified: true,
      sessionId: '',
      sessionCreatedAt: null,
    },
    profile,
  };
}

/**
 * Course-ware access: either a valid legacy student/admin token, or a better-auth
 * session whose holder is an approved student or active staff. Sets `accessor`;
 * route code resolves the cohort from it.
 */
export function requireCourseAccess(deps: UniDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const legacy = tryLegacyClaims(deps.keys, c.req.raw);
    if (legacy) {
      c.set('accessor', { kind: 'legacy', claims: legacy });
      await next();
      return;
    }
    if (deps.accountAuth && deps.pool) {
      const principal = await resolvePrincipal(deps, c.req.raw);
      if (principal) {
        const profile = await profileForUser(deps.pool, principal.userId);
        const staffRoles = await activeStaffRoles(deps.pool, principal.userId);
        const enrolment = profile ? await enrolmentForProfile(deps.pool, profile.id) : null;
        const approved = Boolean(
          principal.emailVerified &&
          profile?.status === 'active' &&
          enrolment?.status === 'approved' &&
          enrolment.cohort_code,
        );
        if (staffRoles.length > 0 || approved) {
          c.set('accessor', {
            kind: 'session',
            principal,
            admission: { profile, enrolment, staffRoles },
          });
          await next();
          return;
        }
      }
    }
    log.warn('course_access_denied', { path: c.req.path });
    return c.json({ error: 'unauthenticated' }, 401);
  };
}

/** Programme-manifest visibility: legacy admin, any active staff, or an approved student. */
export function requireProgrammeAccess(deps: UniDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const legacy = tryLegacyClaims(deps.keys, c.req.raw);
    if (legacy?.role === 'admin') {
      await next();
      return;
    }
    if (legacy) {
      return c.json({ error: 'unapproved', message: 'Programme visibility requires admission or staff access' }, 403);
    }
    if (deps.accountAuth && deps.pool) {
      const principal = await resolvePrincipal(deps, c.req.raw);
      if (principal) {
        const staffRoles = await activeStaffRoles(deps.pool, principal.userId);
        if (staffRoles.length > 0) {
          await next();
          return;
        }
        const profile = await profileForUser(deps.pool, principal.userId);
        const enrolment = profile ? await enrolmentForProfile(deps.pool, profile.id) : null;
        if (principal.emailVerified && profile?.status === 'active' && enrolment?.status === 'approved') {
          await next();
          return;
        }
        return c.json({ error: 'unapproved', message: 'Programme visibility requires admission or staff access' }, 403);
      }
    }
    return c.json({ error: 'unauthenticated' }, 401);
  };
}
