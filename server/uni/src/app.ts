import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { config } from './config';
import type { UniDeps } from './deps';
import { errorFields, log } from './logger';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { staffRoutes } from './routes/staff';
import { studentRoutes } from './routes/student';

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
  });
  const accountBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  app.use('*', async (c, next) => (isAccountAuthPath(c.req.path) ? accountCors(c, next) : defaultCors(c, next)));
  app.use('/v1/auth/*', async (c, next) => (isAccountAuthPath(c.req.path) ? accountBodyLimit(c, next) : next()));

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    log.info('request', { method: c.req.method, path: loggablePath(c.req.path), status: c.res.status, ms: Date.now() - started });
  });

  app.onError((error, c) => {
    if (c.req.path.startsWith('/v1/auth/')) {
      log.error('request_failed', { path: loggablePath(c.req.path) });
      return c.json({ error: 'internal_error' }, 500);
    }
    log.error('request_failed', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: 'internal_error', message: error.message }, 500);
  });

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'uni', issuer: config.issuer, courses: deps.courseware.courses.size }),
  );

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
  app.route('/v1/admin', adminRoutes(deps));
  app.route('/v1/admin', staffRoutes(deps));
  app.route('/v1', meRoutes(deps));
  app.route('/v1', studentRoutes(deps));

  return app;
}
