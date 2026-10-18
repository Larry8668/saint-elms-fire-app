import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { config } from './config';
import type { UniDeps } from './deps';
import { errorFields, log } from './logger';
import { portalRoutes } from './portal/routes';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { shareRoutes } from './routes/shares';
import { staffRoutes } from './routes/staff';
import { studentRoutes } from './routes/student';
import { sessionAdminRoutes, sessionRoutes } from './sessions/routes';

export type { UniDeps } from './deps';

const LEGACY_AUTH_PATHS = new Set(['/v1/auth/login', '/v1/auth/me']);
const REDACTED_AUTH_PATH = '/v1/auth/[redacted]';

function isAccountAuthPath(path: string): boolean {
  return path.startsWith('/v1/auth/') && !LEGACY_AUTH_PATHS.has(path);
}

function loggablePath(path: string): string {
  return path.startsWith('/v1/auth/') ? REDACTED_AUTH_PATH : path;
}

export function createApp(deps: UniDeps) {
  const app = new Hono();
  const defaultCors = cors();
  const accountCors = cors({
    origin: (origin) => ((deps.accountAuth?.trustedOrigins ?? []).includes(origin) ? origin : undefined),
    credentials: true,
    exposeHeaders: ['x-mail-delivery'],
  });
  const authBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  app.use('*', async (c, next) => (isAccountAuthPath(c.req.path) ? accountCors(c, next) : defaultCors(c, next)));
  // Every auth path carries credentials, legacy ones included: all get the same 64KB cap.
  app.use('/v1/auth/*', authBodyLimit);

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    log.info('request', { method: c.req.method, path: loggablePath(c.req.path), status: c.res.status, ms: Date.now() - started });
  });

  app.onError((error, c) => {
    // Thrown HTTPExceptions (the body cap's 413 above all) keep their own status.
    if (error instanceof HTTPException) return error.getResponse();
    if (c.req.path.startsWith('/v1/auth/')) {
      log.error('request_failed', { path: loggablePath(c.req.path) });
      return c.json({ error: 'internal_error' }, 500);
    }
    // Internals stay in the server log; clients get the same generic body everywhere.
    log.error('request_failed', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: 'internal_error' }, 500);
  });

  // `demo` only says whether demo students are seeded (SEED_DEMO), so the portal knows to offer
  // their sign-in. It never carries the password.
  app.get('/health', (c) =>
    c.json({ ok: true, service: 'uni', issuer: config.issuer, courses: deps.courseware.courses.size, demo: config.seedDemo }),
  );

  /**
   * Readiness, distinct from liveness: 200 only while the account layer this server
   * was configured to run is actually usable — database answering and account auth
   * mounted. A deployment without a database is honestly not-ready (503), because every
   * account surface fails closed the same way.
   */
  app.get('/ready', async (c) => {
    const checks: Record<string, boolean> = { accountAuth: Boolean(deps.accountAuth) };
    // Explicit false, not an absent key: readiness must not depend on checks aligning
    // with how deps happen to be wired elsewhere.
    checks.database = deps.pool ? await deps.pool.query('SELECT 1').then(() => true, () => false) : false;
    const ready = Object.values(checks).every(Boolean);
    return c.json({ ok: ready, checks }, ready ? 200 : 503);
  });

  app.get('/v1/keys', (c) => c.json({ issuer: config.issuer, algorithm: 'ed25519', publicKeyPem: deps.keys.publicKeyPem }));

  app.get('/v1/cohorts', (c) => c.json(deps.releases.cohorts().map(({ id, name }) => ({ id, name }))));

  app.route('/v1/auth', authRoutes(deps));
  if (deps.accountAuth) {
    // Deliberate confirmation hop for magic links lives inside the wrapped account handler.
    app.all('/v1/auth/*', (c) => deps.accountAuth!.handler(c.req.raw));
  } else {
    // Fail closed: account endpoints stay unavailable until a database is configured.
    app.all('/v1/auth/*', (c) => c.json({ error: 'account_auth_unavailable' }, 503));
  }
  app.route('/', portalRoutes(deps));
  app.route('/v1/admin', adminRoutes(deps));
  app.route('/v1/admin', staffRoutes(deps));
  app.route('/v1/admin', sessionAdminRoutes(deps));
  app.route('/v1', meRoutes(deps));
  app.route('/v1', shareRoutes(deps));
  app.route('/v1', studentRoutes(deps));
  app.route('/v1', sessionRoutes(deps));

  return app;
}
