import { readFile } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import { config } from '../config';
import type { UniDeps } from '../deps';
import { errorFields, log } from '../logger';
import { devicePageHtml } from './device-page';
import { cacheControlFor, contentTypeFor, etagFor, nonce, resolveAsset, type ResolvedAsset } from './static-files';

/**
 * University-hosted surfaces: the device confirmation page at `/device` and the onboarding
 * shell at `/app`. Both are served by this server so they share its origin, which is what
 * lets the browser send the session cookie to the account endpoints.
 */

/** The device page carries its own inline script and style, both bound to one nonce. */
const inlineCsp = (scriptNonce: string): string =>
  [
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}'`,
    `style-src 'nonce-${scriptNonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

/**
 * The onboarding shell is a built bundle: hashed scripts and stylesheets from this origin,
 * with no inline code. React sets element styles through the `style` attribute, which
 * `style-src-attr` governs separately — inline <style> blocks stay blocked.
 */
const bundleCsp = (): string =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

const hardened = (extra: Record<string, string> = {}): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin',
  'cross-origin-opener-policy': 'same-origin',
  ...extra,
});

export function portalRoutes(deps: UniDeps) {
  const app = new Hono();

  /**
   * Device confirmation. Approving needs a session, so with no account layer configured
   * there is nothing to approve and the page says so instead of implying it worked.
   */
  app.get('/device', (c) => {
    if (!deps.accountAuth) {
      return c.json({ error: 'account_auth_unavailable', message: 'Device sign-in is not configured on this server.' }, 503);
    }
    const scriptNonce = nonce();
    return c.html(devicePageHtml({ nonce: scriptNonce, publicUrl: config.publicUrl }), 200, {
      ...hardened({
        'content-security-policy': inlineCsp(scriptNonce),
        'cache-control': 'no-store',
      }),
    });
  });

  /**
   * The onboarding shell build. Fails closed with a typed error when it has not been built,
   * so a missing asset can never look like a working account surface.
   */
  app.get('/app/*', async (c) => {
    if (!deps.accountAuth) {
      return c.json({ error: 'account_auth_unavailable', message: 'The portal is not configured on this server.' }, 503);
    }
    const requested = c.req.path.slice('/app/'.length);
    let asset = await resolveAsset(config.portalDir, requested || 'index.html');
    // Only the bare `/app` entry point falls back to the shell; a missing sub-path is a 404.
    if (!asset && !requested) asset = await resolveAsset(config.portalDir, 'index.html');
    if (!asset) {
      log.warn('portal_asset_missing', { path: requested });
      return c.json({ error: 'not_found' }, 404);
    }
    return sendAsset(c, asset);
  });

  return app;
}

async function sendAsset(c: Context, asset: ResolvedAsset) {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    // Copied into a plain ArrayBuffer view: a pooled Node Buffer is not a Hono `Data`.
    bytes = Uint8Array.from(await readFile(asset.file));
  } catch (error) {
    log.warn('portal_asset_unreadable', { path: asset.relative, ...errorFields(error) });
    return c.json({ error: 'not_found' }, 404);
  }
  const etag = etagFor(bytes);
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag });
  return c.body(bytes, 200, {
    ...hardened({
      'content-type': contentTypeFor(asset.file),
      'content-security-policy': bundleCsp(),
      'cache-control': cacheControlFor(asset.relative),
      etag,
    }),
  });
}
