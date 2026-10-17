import { createHash, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { errorFields, log } from '../../config';
import { SyncConflictError, type VaultSyncHandle } from '../../sync';
import { bearer } from '../context';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** The flush must answer before the orchestrator's exec is cut (about 60 s). */
export const FLUSH_TIMEOUT_MS = 50_000;

/** Any sign the request came through a proxy: on a hosted seat the edge always adds these. */
const forwarded = (c: Context) => [...c.req.raw.headers.keys()].some((name) => name.startsWith('x-forwarded-') || name === 'forwarded' || name === 'x-real-ip');

const peer = (c: Context): string | null => {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
};

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * POST /api/internal/sync/flush: the final push before a session VM is deleted, called by
 * infra/seat/session-stop.sh from inside the box. Never reachable from outside: the socket peer
 * must be loopback, nothing may have forwarded it, and the bearer must be SYNC_FLUSH_TOKEN.
 */
export function internalSyncRoutes(handle: VaultSyncHandle, timeoutMs = FLUSH_TIMEOUT_MS) {
  const app = new Hono();
  app.post('/internal/sync/flush', async (c) => {
    const address = peer(c);
    if (forwarded(c) || address === null || !LOOPBACK_PEERS.has(address)) {
      log.warn('sync_flush_refused', { reason: 'not_loopback', peer: address });
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const presented = bearer(c.req.header('authorization'));
    // Digests first, so the comparison is constant-time whatever the presented length.
    if (!handle.flushToken || !presented || !timingSafeEqual(digest(presented), digest(handle.flushToken))) {
      log.warn('sync_flush_refused', { reason: 'bad_token' });
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    const { sync } = handle;
    if (!sync.restored) return c.json({ ok: false, error: 'not_restored', version: null }, 409);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const result = await Promise.race([sync.flush(), timeout]);
      if (result === 'timeout') {
        log.error('sync_flush_timeout', { ms: timeoutMs });
        return c.json({ ok: false, error: 'timeout', version: sync.status().version }, 504);
      }
      log.info('sync_flushed', { pushed: result.pushed, version: result.version });
      return c.json({ ok: true, pushed: result.pushed, version: result.version });
    } catch (error) {
      log.error('sync_flush_failed', errorFields(error));
      const code = error instanceof SyncConflictError ? 'conflict' : 'push_failed';
      return c.json({ ok: false, error: code, version: sync.status().version }, code === 'conflict' ? 409 : 502);
    } finally {
      clearTimeout(timer);
    }
  });
  return app;
}
