import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CONTRACT_VERSION, IdentifierSchema, SaveAnswerRequestSchema, SourceReceiptSchema, WikiGraphSchema, WikiIndexSchema, WikiPageViewSchema } from '@sef/shared';
import { WikiQuery } from '../../brain/query';
import { SourceRejection } from '../../brain/sources/ingest';
import { VaultConflictError } from '../../brain/vault-errors';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/**
 * The compiled wiki over HTTP: the catalogue the index summarises, one page through the
 * permitted view, and "save this answer" — which freezes the turn as a source and queues a
 * job. No route here writes a page; only an accepted proposal does.
 */
export function wikiRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  const handled = (error: unknown, fallbackCode: string): { body: { error: string; code: string; details?: unknown }; status: ContentfulStatusCode } => {
    if (error instanceof SourceRejection) return { body: { error: error.message, code: error.code }, status: error.status };
    if (error instanceof VaultConflictError) return { body: { error: error.message, code: 'stale_revision', details: error.details }, status: 409 };
    return { body: { error: friendlyError(error), code: fallbackCode }, status: 500 };
  };

  /** Index summaries and source counts — the catalogue row per compiled page. */
  app.get('/wiki/pages', guard, async (c) => {
    try {
      return c.json(WikiIndexSchema.parse(await new WikiQuery(c.get('ws').wiki).index()));
    } catch (error) {
      const { body, status } = handled(error, 'index_failed');
      return c.json(body, status);
    }
  });

  /** The whole wiki as nodes and edges — derived, read-only, one request for the brain map. */
  app.get('/wiki/graph', guard, async (c) => {
    try {
      return c.json(WikiGraphSchema.parse(await new WikiQuery(c.get('ws').wiki).graph()));
    } catch (error) {
      const { body, status } = handled(error, 'graph_failed');
      return c.json(body, status);
    }
  });

  /** One page with its claims judged against the current source catalogue. */
  app.get('/wiki/pages/:id', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'No page by that id in this wiki', code: 'not_found' }, 404);
    try {
      const view = await new WikiQuery(c.get('ws').wiki).pageView(id.data);
      if (!view) return c.json({ error: 'No page by that id in this wiki', code: 'not_found' }, 404);
      return c.json(WikiPageViewSchema.parse(view));
    } catch (error) {
      const { body, status } = handled(error, 'page_failed');
      return c.json(body, status);
    }
  });

  /**
   * Save to wiki: the chosen assistant turn is frozen as an 'answer' source (origin model)
   * and its job is queued. The compile and the review decision run through the same
   * proposal pipeline as every other contribution — there is no shorter path to a page.
   */
  app.post('/wiki/save', guard, async (c) => {
    const parsed = SaveAnswerRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send a sessionId and optionally a turnIndex, title and saveKind', code: 'invalid_request' }, 400);
    try {
      const ws = c.get('ws');
      const session = await ws.sessions.get(parsed.data.sessionId);
      if (!session) return c.json({ error: 'Session not found', code: 'not_found' }, 404);
      const result = await ws.brain.saveAnswer(session, parsed.data);
      const extraction = result.extraction
        ? { method: result.extraction.method, text: result.extraction.text, partial: result.extraction.partial, ...(result.extraction.note ? { note: result.extraction.note } : {}) }
        : null;
      return c.json(SourceReceiptSchema.parse({ schemaVersion: CONTRACT_VERSION, source: result.source, extraction, jobId: result.jobId, reused: result.reused }), 201);
    } catch (error) {
      const { body, status } = handled(error, 'save_failed');
      return c.json(body, status);
    }
  });

  return app;
}
