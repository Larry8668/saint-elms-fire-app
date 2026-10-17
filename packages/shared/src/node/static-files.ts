import { createHash, randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Static assets for the hosted surfaces: the uni's `/app` and `/admin`, and the student UI
 * an engine serves for a hosted seat. Resolves inside a root only: a request can never
 * escape it, and a symlink that points outside is refused rather than followed.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const contentTypeFor = (file: string): string => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

export interface ResolvedAsset {
  /** Absolute path on disk, already proven to sit inside the root. */
  file: string;
  /** Path relative to the root, with `/` separators, for logging. */
  relative: string;
}

/**
 * Maps a request path onto a file inside `root`, or returns null when the path escapes,
 * is absolute, contains a null byte, or would resolve to a directory.
 */
export async function resolveAsset(root: string, requestPath: string): Promise<ResolvedAsset | null> {
  if (!root || requestPath.includes('\0')) return null;
  if (path.isAbsolute(requestPath)) return null;

  const base = path.resolve(root);
  const candidate = path.resolve(base, `.${path.posix.normalize(`/${requestPath}`)}`);
  // Defence in depth: a normalize that produced a traversal still has to pass this check.
  if (candidate !== base && !candidate.startsWith(base + path.sep)) return null;

  // Resolve the entire path, not just its last component. A symlinked *directory* inside
  // the root can otherwise lead out of it while the file it reaches looks like an
  // ordinary regular file. Compared against the real root, because on macOS the temp dir
  // itself sits under /private/var.
  const realBase = await realpath(base).catch(() => null);
  const real = realBase ? await realpath(candidate).catch(() => null) : null;
  if (!realBase || !real || (real !== realBase && !real.startsWith(realBase + path.sep))) return null;

  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) return null;

  return { file: candidate, relative: path.relative(base, candidate).split(path.sep).join('/') };
}

/** Strong validator over the exact bytes being sent, so a redeploy can never serve a stale 304. */
export const etagFor = (bytes: Uint8Array): string => `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`;

/**
 * Immutable hashed bundle assets can be cached hard; anything else must revalidate so a
 * deploy is not served stale. `index.html` is always revalidated.
 */
export function cacheControlFor(relative: string): string {
  if (relative.startsWith('assets/') && /-[A-Za-z0-9_]{8,}\.(js|css|woff2?|ttf|png|svg|webp)$/.test(relative)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

/** Per-response nonce so the inline confirmation script needs no CSP `unsafe-inline`. */
export const nonce = (): string => randomBytes(16).toString('base64');
