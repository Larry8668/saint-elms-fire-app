import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config';
import type { UniDeps } from './deps';
import { errorFields, log } from './logger';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { studentRoutes } from './routes/student';

export type { UniDeps } from './deps';

export function createApp(deps: UniDeps) {
  const app = new Hono();
  app.use('*', cors());

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  app.onError((error, c) => {
    log.error('request_failed', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: 'internal_error', message: error.message }, 500);
  });

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'uni', issuer: config.issuer, courses: deps.courseware.courses.size }),
  );

  app.get('/v1/keys', (c) => c.json({ issuer: config.issuer, algorithm: 'ed25519', publicKeyPem: deps.keys.publicKeyPem }));

  app.get('/v1/cohorts', (c) => c.json(deps.releases.cohorts().map(({ id, name }) => ({ id, name }))));

  app.route('/v1/auth', authRoutes(deps));
  app.route('/v1/admin', adminRoutes(deps));
  app.route('/v1', studentRoutes(deps));

  return app;
}
