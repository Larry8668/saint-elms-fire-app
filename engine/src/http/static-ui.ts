import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { cacheControlFor, contentTypeFor, etagFor, resolveAsset, type ResolvedAsset } from '@sef/shared/node';
import { errorFields, log } from '../config';
import type { EngineEnv } from './context';
import type { EdgePolicy } from './edge';

/**
 * The built student UI, served from the engine's own origin so a hosted seat needs no
 * install: same rules as the uni's portal surfaces — traversal-proof, symlinks refused,
 * hashed assets cached hard, the shell revalidated.
 */

/**
 * The bundle loads only from this origin and talks only to it. React and the KaTeX/sky
 * styles set inline styles, so styles allow 'unsafe-inline' (the Tauri shell's CSP does
 * the same); scripts never do.
 */
const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** A path the SPA routes itself: no file extension in its last segment. */
const isAppRoute = (requested: string) => !path.posix.basename(requested).includes('.');

export function staticUiRoutes(root: string, edge: Pick<EdgePolicy, 'scheme'>) {
  const app = new Hono<EngineEnv>();
  // A relative ENGINE_STATIC_DIR resolves against the engine's cwd (engine/ under pnpm), so say both.
  if (!existsSync(path.join(root, 'index.html'))) {
    log.warn('static_ui_missing', { root, configured: process.env.ENGINE_STATIC_DIR, cwd: process.cwd(), hint: 'use an absolute ENGINE_STATIC_DIR' });
  }
  else log.info('static_ui_enabled', { root });

  const headers = (c: Context<EngineEnv>, asset: ResolvedAsset, etag: string): Record<string, string> => ({
    'content-type': contentTypeFor(asset.file),
    'content-security-policy': UI_CSP,
    'cache-control': cacheControlFor(asset.relative),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), geolocation=(), microphone=(self)',
    // Only over the seat's TLS edge, as a trusted proxy reports it; a loopback engine is plain http.
    ...(edge.scheme(c) === 'https' ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    etag,
  });

  const send = async (c: Context<EngineEnv>, asset: ResolvedAsset) => {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(await readFile(asset.file));
    } catch (error) {
      log.warn('static_ui_unreadable', { path: asset.relative, ...errorFields(error) });
      return c.json({ error: 'Not found' }, 404);
    }
    const etag = etagFor(bytes);
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag });
    return c.body(bytes, 200, headers(c, asset, etag));
  };

  app.get('*', async (c) => {
    // The API owns /api entirely: an unknown API path is a JSON 404, never the shell.
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
    const requested = c.req.path.replace(/^\/+/, '');
    let asset = await resolveAsset(root, requested || 'index.html');
    // Client routes fall back to the shell; a missing file (an asset, a probe for
    // /.env) stays a 404 so it can never look like a working page.
    if (!asset && isAppRoute(requested) && !requested.startsWith('assets/')) asset = await resolveAsset(root, 'index.html');
    if (!asset) return c.json({ error: 'Not found' }, 404);
    return send(c, asset);
  });

  return app;
}
