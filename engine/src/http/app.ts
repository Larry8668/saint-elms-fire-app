import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HealthResponse } from '@sef/shared';
import { config, errorFields, log } from '../config';
import { checkRoles } from '../models/health';
import { uniFetch } from '../uni/client';
import { webReachable } from '../web/searxng';
import type { EngineDeps, EngineEnv } from './context';
import { errorStatus, friendlyError } from './errors';
import { authRoutes } from './routes/auth';
import { settingsRoutes } from './routes/settings';
import { studentRoutes } from './routes/student';

export type { EngineDeps } from './context';

async function uniReachable(url: string): Promise<boolean> {
  try {
    await uniFetch(url, '/health', { timeoutMs: 2500 });
    return true;
  } catch {
    return false;
  }
}

export function createApp(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  app.use('*', cors());

  app.use('/api/*', async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path !== '/api/health') log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  app.onError((error, c) => {
    log.error('request_failed', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: friendlyError(error) }, errorStatus(error));
  });

  /** Public: the sign-in screen uses this to show whether we are online. */
  app.get('/api/health', async (c) => {
    const settings = await deps.settings.get();
    const [uni, models, web] = await Promise.all([uniReachable(settings.uniServerUrl), checkRoles(settings), webReachable(settings.searxngUrl)]);
    const body: HealthResponse = {
      ok: true,
      engine: config.version,
      uni: { reachable: uni, url: settings.uniServerUrl },
      models,
      web: { reachable: web },
    };
    return c.json(body);
  });

  app.route('/api/auth', authRoutes(deps));
  app.route('/api', settingsRoutes(deps));
  app.route('/api', studentRoutes(deps));

  return app;
}
