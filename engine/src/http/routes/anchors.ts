import { Hono } from 'hono';
import { AnchorCatalogSchema, AnchorMatchResultSchema, CONTRACT_VERSION, IdentifierSchema, WebPreviewSchema } from '@sef/shared';
import { ANCHOR_FAILURE_COPY } from '../../agents/anchor';
import { anchorCatalog, anchorTopic, matchAnchorPages, profileAnchors, type AnchorContext } from '../../agents/anchors';
import { errorFields, log } from '../../config';
import type { Workspace } from '../../profiles/workspace';
import { webReachable } from '../../web/searxng';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

/**
 * The workspace slice every anchor decision is judged against: the student's own vault
 * (fresh from disk), the released course graph it must stay linked to, and the programme
 * the typed course references are scoped to. Built per request — nothing here is cached
 * across turns, so a page changed between catalogue and claim is caught by the seam.
 */
export async function anchorContext(ws: Workspace): Promise<AnchorContext> {
  return {
    wiki: ws.wiki,
    vault: ws.vault,
    graph: await ws.brain.courseGraph(),
    programmeId: ws.profile.programmeId ?? ws.profile.cohortId ?? '',
  };
}

const ANCHOR_STATUS = {
  no_anchor: 409,
  syllabus_concept_not_an_anchor: 409,
  uncommitted_page: 404,
  stale_revision: 409,
  not_a_course_concept: 409,
} as const;

/**
 * The Philosopher's exploration surface: what the student's wiki currently offers as a
 * starting point, judged per request. A catalogue row is a claim, not proof — the turn
 * itself re-reads the page from disk before the anchor counts.
 */
export function anchorRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  /** Every committed, course-linked concept page this student can currently explore from. */
  app.get('/anchors', guard, async (c) => {
    const ws = c.get('ws');
    try {
      const anchors = await anchorCatalog(await anchorContext(ws));
      return c.json(AnchorCatalogSchema.parse({ schemaVersion: CONTRACT_VERSION, anchors }));
    } catch (error) {
      log.warn('anchor_catalog_failed', { profileId: ws.profile.id, ...errorFields(error) });
      return c.json({ error: 'The wiki catalogue could not be read.' }, 500);
    }
  });

  /**
   * Free text against the catalogue. `resolved` pins the page and its current revision;
   * `ambiguous` hands the candidates back so the student chooses — the engine never picks;
   * `none` leaves the Philosopher's named refusal to say what happened.
   */
  app.get('/anchors/match', guard, async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ error: 'Send the text to match as ?q=' }, 400);
    const ws = c.get('ws');
    try {
      const match = matchAnchorPages(await anchorCatalog(await anchorContext(ws)), q);
      return c.json(AnchorMatchResultSchema.parse({ schemaVersion: CONTRACT_VERSION, ...match }));
    } catch (error) {
      log.warn('anchor_match_failed', { profileId: ws.profile.id, ...errorFields(error) });
      return c.json({ error: 'The wiki catalogue could not be read.' }, 500);
    }
  });

  /**
   * What consenting to web search would send this turn: a topic-only query derived in code
   * from the anchored page's released-course label, plus where it would go. Nothing here
   * searches the web — `reachable` is a health probe, not a query.
   */
  app.get('/anchors/:pageId/web-preview', guard, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('pageId'));
    if (!id.success) return c.json({ error: 'No page with this id', code: 'uncommitted_page' }, 404);
    const ws = c.get('ws');
    const resolution = await profileAnchors(await anchorContext(ws)).resolve({ teacher: 'philosopher', anchorPageId: id.data, committed: new Map() });
    if (!resolution.ok || !resolution.candidate) {
      const reason = resolution.ok ? 'uncommitted_page' : resolution.reason;
      return c.json({ error: ANCHOR_FAILURE_COPY[reason], code: reason }, ANCHOR_STATUS[reason]);
    }
    const { searxngUrl } = await ws.settings.get();
    let host = '';
    try {
      host = new URL(searxngUrl).host;
    } catch {
      host = searxngUrl;
    }
    const reachable = await webReachable(searxngUrl);
    return c.json(WebPreviewSchema.parse({ schemaVersion: CONTRACT_VERSION, query: anchorTopic(resolution.candidate), engine: 'searxng', host, reachable }));
  });

  return app;
}
