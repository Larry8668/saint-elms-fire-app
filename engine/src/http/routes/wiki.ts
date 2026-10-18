import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CONTRACT_VERSION,
  IdentifierSchema,
  SaveAnswerRequestSchema,
  SourceReceiptSchema,
  WikiAskRequestSchema,
  WikiAskResultSchema,
  WikiDisputesSchema,
  WikiGraphSchema,
  WikiIndexSchema,
  WikiPageViewSchema,
  type WikiAskStreamEvent,
} from '@sef/shared';
import { askWiki, AskStore, tutorComplete, type AskComplete } from '../../brain/ask';
import { WikiQuery } from '../../brain/query';
import { errorFields, log } from '../../config';
import type { Workspace } from '../../profiles/workspace';
import { SourceRejection } from '../../brain/sources/ingest';
import { VaultConflictError } from '../../brain/vault-errors';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/**
 * The compiled wiki over HTTP: the catalogue the index summarises, one page through the
 * permitted view, and "save this answer" — which freezes the turn as a source and queues a
 * job. No route here writes a page; only an accepted proposal does.
 */
export interface WikiRouteOptions {
  /** The model call behind /wiki/ask — the tutor role by default; tests pass a fake. */
  complete?: (ws: Workspace) => AskComplete;
}

/** Kept asks sit beside the other operational stores under the profile root, outside the vault. */
const askStore = (ws: Workspace) => new AskStore(path.join(ws.paths.root, 'asks'));

export function wikiRoutes(deps: EngineDeps, opts: WikiRouteOptions = {}) {
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

  /** Every disagreement the vault keeps — disputed claim pairs and unresolved misconceptions. Read-only. */
  app.get('/wiki/disputes', guard, async (c) => {
    try {
      return c.json(WikiDisputesSchema.parse(await new WikiQuery(c.get('ws').wiki).disputes()));
    } catch (error) {
      const { body, status } = handled(error, 'disputes_failed');
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
    if (!parsed.success) return c.json({ error: 'Send a sessionId (or an askId) and optionally a turnIndex, title and saveKind', code: 'invalid_request' }, 400);
    try {
      const ws = c.get('ws');
      const { sessionId, askId, ...input } = parsed.data;
      let result: Awaited<ReturnType<typeof ws.brain.saveAnswer>>;
      if (askId) {
        const ask = await askStore(ws).get(askId);
        if (!ask) return c.json({ error: 'That answer is no longer kept — ask again to save it.', code: 'not_found' }, 404);
        result = await ws.brain.saveAsk(ask, { title: input.title, saveKind: input.saveKind });
      } else {
        const session = await ws.sessions.get(sessionId!);
        if (!session) return c.json({ error: 'Session not found', code: 'not_found' }, 404);
        result = await ws.brain.saveAnswer(session, input);
      }
      const extraction = result.extraction
        ? { method: result.extraction.method, text: result.extraction.text, partial: result.extraction.partial, ...(result.extraction.note ? { note: result.extraction.note } : {}) }
        : null;
      return c.json(SourceReceiptSchema.parse({ schemaVersion: CONTRACT_VERSION, source: result.source, extraction, jobId: result.jobId, reused: result.reused }), 201);
    } catch (error) {
      const { body, status } = handled(error, 'save_failed');
      return c.json(body, status);
    }
  });

  /**
   * Ask your brain: a question answered only from the student's own pages, streamed over
   * SSE so the first words arrive well inside a hosted edge's budget. Frames: status,
   * pages (what was read), delta (citation-checked text), then one done carrying the
   * whole answer, its surviving citations and the askId "Save to wiki" takes.
   */
  app.post('/wiki/ask', guard, async (c) => {
    const parsed = WikiAskRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send a question of at least a few characters', code: 'invalid_request' }, 400);
    const ws = c.get('ws');
    const complete = opts.complete?.(ws) ?? tutorComplete(() => ws.settings.get());
    return streamSSE(c, async (stream) => {
      // Frames are written in order and the last one is awaited before the stream closes.
      let written: Promise<unknown> = Promise.resolve();
      const emit = (event: WikiAskStreamEvent) => {
        written = written.then(() => stream.writeSSE({ data: JSON.stringify(event) })).catch(() => undefined);
      };
      try {
        const result = await askWiki(
          parsed.data.question,
          { wiki: ws.wiki, embed: ws.embeddings?.for('pages'), complete, store: askStore(ws) },
          emit,
        );
        log.info('wiki_ask', { profileId: ws.profile.id, outcome: result.outcome, read: result.pagesRead.length, cited: result.citations.length, dropped: result.droppedCitations.length });
        emit({ type: 'done', result: WikiAskResultSchema.parse(result) });
      } catch (error) {
        log.error('wiki_ask_failed', { profileId: ws.profile.id, ...errorFields(error) });
        emit({ type: 'error', message: friendlyError(error), code: 'ask_failed' });
      }
      await written;
    });
  });

  return app;
}
