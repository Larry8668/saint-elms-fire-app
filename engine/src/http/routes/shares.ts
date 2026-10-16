import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { PublishShareRequestSchema, ShareDraftRequestSchema } from '@sef/shared';
import { z } from 'zod';
import { PeerShareError } from '../../shares/service';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/** Maps a PeerShareError code — which is the uni's own code where one exists — to a status. */
const ERROR_STATUS: Record<string, ContentfulStatusCode> = {
  no_session: 401,
  unauthenticated: 401,
  forbidden: 403,
  unapproved: 403,
  programme_mismatch: 403,
  not_found: 404,
  not_author: 404,
  invalid_request: 400,
  invalid_share: 400,
  invalid_cursor: 400,
  attachment_too_large: 400,
  attachment_type: 400,
  unshareable_page: 400,
  idempotency_conflict: 409,
  not_published: 409,
  quota_exceeded: 429,
  share_too_large: 413,
  unreachable: 503,
  admission_unavailable: 503,
};

const ignoreBody = z.strictObject({ ignored: z.boolean() });

/**
 * Cohort sharing over the live university API: publish drafts, the peer feed,
 * the author's own items and imports. Every route is workspace-scoped (`c.get('ws')`),
 * and every failure surfaces as an honest `{ error, code }` — the feed itself
 * reports unreachable/unauthenticated as data because those are expected states.
 */
export function shareRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  const handled = (error: unknown): { body: { error: string; code: string }; status: ContentfulStatusCode } => {
    if (error instanceof PeerShareError) {
      const status = (error.status ?? ERROR_STATUS[error.code] ?? 500) as ContentfulStatusCode;
      return { body: { error: error.message, code: error.code }, status };
    }
    return { body: { error: friendlyError(error), code: 'share_failed' }, status: 500 };
  };

  /** The student's own cohort feed — one page, cursor-paginated. */
  app.get('/shares/feed', guard, async (c) => {
    const feed = await c.get('ws').peerShares.feed({
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    return c.json(feed);
  });

  /** The author's own items, including withdrawn ones. */
  app.get('/shares/mine', guard, async (c) => c.json(await c.get('ws').peerShares.mine()));

  /** The wiki pages the student may publish — every kind, not just concept pages. */
  app.get('/shares/pages', guard, async (c) => c.json(await c.get('ws').peerShares.pages()));

  /** Builds the exact network payload for preview; nothing goes on the wire here. */
  app.post('/shares/prepare', guard, async (c) => {
    const parsed = ShareDraftRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send a pageId and optional attachmentSourceIds', code: 'invalid_request' }, 400);
    try {
      return c.json(await c.get('ws').peerShares.prepare(parsed.data));
    } catch (error) {
      const { body, status } = handled(error);
      return c.json(body, status);
    }
  });

  /** Publishes the previewed request verbatim; the uni's idempotency handles replays. */
  app.post('/shares/publish', guard, async (c) => {
    const parsed = PublishShareRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the exact request the prepare step returned', code: 'invalid_request', issues: parsed.error.issues }, 400);
    try {
      return c.json(await c.get('ws').peerShares.publish(parsed.data));
    } catch (error) {
      const { body, status } = handled(error);
      return c.json(body, status);
    }
  });

  app.post('/shares/:id/withdraw', guard, async (c) => {
    try {
      return c.json(await c.get('ws').peerShares.withdraw(c.req.param('id')));
    } catch (error) {
      const { body, status } = handled(error);
      return c.json(body, status);
    }
  });

  app.post('/shares/:id/ignore', guard, async (c) => {
    const parsed = ignoreBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send { ignored: boolean }', code: 'invalid_request' }, 400);
    await c.get('ws').peerShares.ignore(c.req.param('id'), parsed.data.ignored);
    return c.body(null, 204);
  });

  /** Imports a feed item as a peer source and compiles it — the proposal still waits on the student's review. */
  app.post('/shares/:id/import', guard, async (c) => {
    try {
      return c.json(await c.get('ws').peerShares.importShare(c.req.param('id')));
    } catch (error) {
      const { body, status } = handled(error);
      return c.json(body, status);
    }
  });

  return app;
}
