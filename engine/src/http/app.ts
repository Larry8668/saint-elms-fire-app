import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { HealthResponse } from '@sef/shared';
import { config, errorFields, log } from '../config';
import { checkRoles } from '../models/health';
import { uniFetch } from '../uni/client';
import { webReachable } from '../web/searxng';
import type { EngineDeps, EngineEnv } from './context';
import { errorStatus, friendlyError } from './errors';
import { anchorRoutes } from './routes/anchors';
import { authRoutes } from './routes/auth';
import { logisticsRoutes } from './routes/logistics';
import { settingsRoutes } from './routes/settings';
import { shareRoutes } from './routes/shares';
import { studentRoutes } from './routes/student';
import { MAX_ENVELOPE_CHARS, sourceRoutes } from './routes/sources';
import { vaultRoutes } from './routes/vault';
import { wikiRoutes } from './routes/wiki';

export type { EngineDeps } from './context';

/**
 * Origins allowed to call the engine with browser credentials: the Vite dev server and
 * the Tauri webview schemes. A hostile web page can hit 127.0.0.1 but cannot produce an
 * allowed Origin header — and the Host check additionally rejects DNS-rebound requests.
 */
const ALLOWED_ORIGINS = new Set(
  [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    ...(process.env.ENGINE_ALLOWED_ORIGINS ?? '').split(','),
  ]
    .map((o) => o.trim())
    .filter(Boolean),
);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const hostName = (host: string | undefined): string => {
  if (!host) return '';
  const bracketed = host.match(/^\[(.+)\]/)?.[1];
  return (bracketed ?? host.split(':')[0]!).toLowerCase();
};

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
  app.use(
    '*',
    cors({
      origin: (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : null),
      allowHeaders: ['authorization', 'content-type'],
      credentials: false,
    }),
  );

  app.use('/api/*', async (c, next) => {
    // The engine only ever serves loopback clients; any other Host is a rebound name.
    if (!LOOPBACK_HOSTS.has(hostName(c.req.header('host')))) {
      return c.json({ error: 'Forbidden host', code: 'forbidden_host' }, 403);
    }
    // Mutations require no Origin (curl, Tauri native) or an allowed one. A cross-site
    // browser request always carries a forbidden Origin and dies here.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        log.warn('forbidden_origin', { origin, path: c.req.path });
        return c.json({ error: 'Forbidden origin', code: 'forbidden_origin' }, 403);
      }
    }
    await next();
  });

  // Vault restores and source uploads carry base64-encoded originals — audio recordings
  // run to the 256 MB decoded cap, so the sources envelope sets that route's ceiling.
  // Everything else keeps the tighter cap.
  app.use('/api/*', (c, next) => {
    const maxSize = c.req.path.startsWith('/api/vault/import')
      ? 160 * 1024 * 1024
      : c.req.path === '/api/sources'
        ? MAX_ENVELOPE_CHARS + 8 * 1024
        : 20 * 1024 * 1024;
    return bodyLimit({ maxSize, onError: (inner) => inner.json({ error: 'Request too large' }, 413) })(c, next);
  });

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
  app.route('/api', anchorRoutes(deps));
  app.route('/api', sourceRoutes(deps));
  app.route('/api', vaultRoutes(deps));
  app.route('/api', wikiRoutes(deps));
  app.route('/api', shareRoutes(deps));
  app.route('/api', logisticsRoutes(deps));

  return app;
}
