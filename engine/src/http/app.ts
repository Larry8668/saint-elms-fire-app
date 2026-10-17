import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { HealthLiveness, HealthResponse } from '@sef/shared';
import { config, errorFields, log } from '../config';
import { cachedReachability, probeHealth, uniReachable } from '../system/health';
import { webReachable } from '../web/searxng';
import { requireProfile, type EngineDeps, type EngineEnv } from './context';
import { edgePolicy } from './edge';
import { errorStatus, friendlyError } from './errors';
import { anchorRoutes } from './routes/anchors';
import { attentionRoutes } from './routes/attention';
import { feedRoutes } from './routes/feeds';
import { metricsRoutes } from './routes/metrics';
import { planRoutes } from './routes/plans';
import { suggestRoutes } from './routes/suggest';
import { authRoutes } from './routes/auth';
import { logisticsRoutes } from './routes/logistics';
import { settingsRoutes } from './routes/settings';
import { shareRoutes } from './routes/shares';
import { studentRoutes } from './routes/student';
import { systemRoutes } from './routes/system';
import { MAX_ENVELOPE_CHARS, sourceRoutes } from './routes/sources';
import { staticUiRoutes } from './static-ui';
import { internalSyncRoutes } from './routes/internal-sync';
import { vaultRoutes } from './routes/vault';
import { wikiRoutes } from './routes/wiki';

export type { EngineDeps } from './context';

export function createApp(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const publicUniReachable = cachedReachability(uniReachable);
  // Origin and Host allowlists (see edge.ts): loopback by default, plus a hosted seat's own name.
  const edge = edgePolicy(process.env, config.port);
  const ALLOWED_ORIGINS = edge.origins;

  // Every path, not only /api: a DNS-rebound name must not be served the UI either.
  app.use('*', async (c, next) => {
    if (!edge.admits(c)) {
      return c.json({ error: 'Forbidden host', code: 'forbidden_host' }, 403);
    }
    await next();
  });

  // Public liveness is readable from any origin: the university portal checks a workspace VM
  // answers before handing the student to it (PR-45). The body is public anyway, carries no
  // credentials (no Allow-Credentials) and the route takes none.
  app.use('/api/health', async (c, next) => {
    await next();
    if (c.req.method === 'GET' && !c.res.headers.has('access-control-allow-origin')) c.res.headers.set('access-control-allow-origin', '*');
  });

  app.use(
    '*',
    cors({
      origin: (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : null),
      allowHeaders: ['authorization', 'content-type'],
      credentials: false,
    }),
  );

  app.use('/api/*', async (c, next) => {
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

  // A session VM serves nothing of the student's until their vault is back: an empty vault
  // served (and then pushed) in the meantime would look like a vault wiped clean.
  const vaultSync = deps.vaultSync?.sync;
  if (vaultSync) {
    app.use('/api/*', async (c, next) => {
      if (vaultSync.restored || c.req.path === '/api/health' || c.req.path.startsWith('/api/internal/sync/')) return next();
      const failed = vaultSync.state === 'error';
      return c.json(
        { error: failed ? 'Your workspace could not be restored.' : 'Your workspace is still being restored.', code: failed ? 'vault_restore_failed' : 'vault_restoring' },
        503,
      );
    });
    // Every successful mutation may have written the profile; the push is debounced.
    app.use('/api/*', async (c, next) => {
      await next();
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS' && c.res.ok) vaultSync.markDirty();
    });
  }

  app.use('/api/*', async (c, next) => {
    const started = Date.now();
    await next();
    if (!c.req.path.startsWith('/api/health')) log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  // Write triggers: any successful profile mutation may change what a detector sees.
  // Attention's own bookkeeping is excluded so dismissing never re-evaluates.
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return;
    if (!c.res.ok || c.req.path.startsWith('/api/attention')) return;
    c.get('ws')?.signals?.touch();
  });

  app.onError((error, c) => {
    log.error('request_failed', { path: c.req.path, ...errorFields(error) });
    return c.json({ error: friendlyError(error) }, errorStatus(error));
  });

  /**
   * Public liveness: a hosted seat's URL is reachable by anyone, so it names nothing about the
   * setup beyond one boolean (is the university up), cached so a public hit never probes it.
   */
  app.get('/api/health', async (c) => {
    const settings = await deps.settings.get();
    const body: HealthLiveness = { ok: true, engine: config.version, uni: { reachable: await publicUniReachable(settings.uniServerUrl) } };
    // One word, no data: the orchestrator waits for 'ready' before handing the URL over.
    if (vaultSync) body.sync = { state: vaultSync.state };
    return c.json(body);
  });

  /** The full model, uni and web report, for a signed-in client. */
  app.get('/api/health/detail', requireProfile(deps), async (c) => {
    const settings = await deps.settings.get();
    const [{ uni, models }, web] = await Promise.all([probeHealth(settings), webReachable(settings.searxngUrl)]);
    const body: HealthResponse = {
      ok: true,
      engine: config.version,
      uni: { reachable: uni, url: settings.uniServerUrl },
      models,
      web: { reachable: web },
    };
    if (vaultSync) {
      const { state, savedAt, pending } = vaultSync.status();
      body.sync = { state, savedAt, pending };
    }
    return c.json(body);
  });

  if (deps.vaultSync) app.route('/api', internalSyncRoutes(deps.vaultSync));
  app.route('/api/auth', authRoutes(deps));
  app.route('/api', settingsRoutes(deps));
  app.route('/api', systemRoutes(deps));
  app.route('/api', studentRoutes(deps));
  app.route('/api', anchorRoutes(deps));
  app.route('/api', sourceRoutes(deps));
  app.route('/api', vaultRoutes(deps));
  app.route('/api', wikiRoutes(deps));
  app.route('/api', shareRoutes(deps));
  app.route('/api', logisticsRoutes(deps));
  app.route('/api', attentionRoutes(deps));
  app.route('/api', suggestRoutes(deps));
  app.route('/api', feedRoutes(deps));
  app.route('/api', planRoutes(deps));
  app.route('/api', metricsRoutes(deps));

  // A hosted seat serves the built UI itself; registered last so it can never shadow /api.
  const staticDir = process.env.ENGINE_STATIC_DIR?.trim();
  if (staticDir) app.route('/', staticUiRoutes(path.resolve(staticDir), edge));

  return app;
}
