import { Hono, type MiddlewareHandler } from 'hono';
import { TokenError, verifyToken } from '@sef/shared/node';
import { requireAdmission, type AppEnv } from '../authorization';
import type { UniDeps } from '../deps';
import { log } from '../logger';
import type { Account } from './store';

type SessionEnv = AppEnv & { Variables: AppEnv['Variables'] & { sessionAccount: Account; actor: string } };

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

/**
 * An approved, enrolled student: a better-auth session through the existing admission guard
 * (account = user.id, what a device sign-in on the VM pins), or a legacy student token for
 * an enabled account (account = account.id, what a password sign-in on the VM pins).
 */
function requireSessionStudent(deps: UniDeps): MiddlewareHandler<SessionEnv> {
  const approved = requireAdmission(deps, { approved: true });
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (token?.startsWith('sef1')) {
      let sub: string;
      try {
        const claims = verifyToken(token, deps.keys.publicKeyPem);
        if (claims.role !== 'student') return c.json({ error: 'forbidden' }, 403);
        sub = claims.sub;
      } catch (error) {
        if (!(error instanceof TokenError)) throw error;
        return c.json({ error: 'unauthenticated' }, 401);
      }
      const account = deps.accounts.get(sub);
      if (!account || account.disabled || account.role !== 'student') return c.json({ error: 'unapproved', message: 'Account unavailable' }, 403);
      if (!ACCOUNT_ID.test(sub)) return c.json({ error: 'account_unsupported' }, 409);
      c.set('sessionAccount', { id: sub, kind: 'legacy' });
      return next();
    }
    return approved(c as never, async () => {
      const userId = c.get('principal').userId;
      if (!ACCOUNT_ID.test(userId)) {
        c.res = c.json({ error: 'account_unsupported' }, 409);
        return;
      }
      c.set('sessionAccount', { id: userId, kind: 'user' });
      await next();
    });
  };
}

/** Legacy admin token, or active staff (fresh session for mutations), like the rest of /v1/admin. */
function requireSessionStaff(deps: UniDeps, mutation: boolean): MiddlewareHandler<SessionEnv> {
  const staff = requireAdmission(deps, mutation ? { staff: 'any', maxSessionAgeMinutes: 30 } : { staff: 'any' });
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (token?.startsWith('sef1')) {
      try {
        const claims = verifyToken(token, deps.keys.publicKeyPem);
        if (claims.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
        c.set('actor', claims.sub);
      } catch (error) {
        if (!(error instanceof TokenError)) throw error;
        return c.json({ error: 'unauthenticated' }, 401);
      }
      return next();
    }
    return staff(c as never, async () => {
      c.set('actor', `user:${c.get('principal').userId}`);
      await next();
    });
  };
}

const unavailable = { error: 'session_orchestrator_unavailable', message: 'Hosted workspaces are not configured on this server.' };

/** POST/GET/DELETE /v1/session and /v1/session/heartbeat. Every lookup is by the caller's own account. */
export function sessionRoutes(deps: UniDeps) {
  const app = new Hono<SessionEnv>();
  const student = requireSessionStudent(deps);

  app.post('/session', student, async (c) => {
    if (!deps.sessions) return c.json(unavailable, 503);
    const status = await deps.sessions.request(c.get('sessionAccount'));
    return c.json(status, status.state === 'ready' ? 200 : 202);
  });

  app.get('/session', student, async (c) => {
    if (!deps.sessions) return c.json(unavailable, 503);
    const status = await deps.sessions.status(c.get('sessionAccount'));
    return status ? c.json(status) : c.json({ error: 'no_session' }, 404);
  });

  app.post('/session/heartbeat', student, async (c) => {
    if (!deps.sessions) return c.json(unavailable, 503);
    const status = await deps.sessions.heartbeat(c.get('sessionAccount'));
    return status ? c.json(status) : c.json({ error: 'no_session' }, 404);
  });

  app.delete('/session', student, async (c) => {
    if (!deps.sessions) return c.json(unavailable, 503);
    const status = await deps.sessions.end(c.get('sessionAccount'), 'logout');
    return status ? c.json(status, 202) : c.json({ error: 'no_session' }, 404);
  });

  return app;
}

/** Staff: GET /v1/admin/sessions (no URLs or tokens) and POST /v1/admin/sessions/:id/end. */
export function sessionAdminRoutes(deps: UniDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/sessions', requireSessionStaff(deps, false), async (c) => {
    if (!deps.sessions) return c.json(unavailable, 503);
    return c.json({ sessions: await deps.sessions.listActive(), maxConcurrent: deps.sessions.config.maxConcurrent });
  });

  app.post('/sessions/:id/end', requireSessionStaff(deps, true), async (c) => {
    if (!deps.sessions) return c.json(unavailable, 503);
    const id = c.req.param('id');
    const status = await deps.sessions.forceEnd(id, 'staff_ended');
    if (!status) return c.json({ error: 'not_found' }, 404);
    await deps.audit.record(c.get('actor'), 'session_force_ended', `session ${id}`);
    log.info('session_force_ended', { sessionId: id });
    return c.json({ id: status.id, state: status.state }, 202);
  });

  return app;
}
