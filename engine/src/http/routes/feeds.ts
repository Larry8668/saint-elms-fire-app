import { Hono } from 'hono';
import { AddFeedRequestSchema, FeedConsentRequestSchema } from '@sef/shared';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

/** Subject feeds. Adding never fetches; only a consent call opens a feed's host for polling. */
export function feedRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  app.get('/feeds', guard, async (c) => c.json(await c.get('ws').feeds.list()));

  app.post('/feeds', guard, async (c) => {
    const parsed = AddFeedRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid feed', issues: parsed.error.issues }, 400);
    const result = await c.get('ws').feeds.add(parsed.data.url, parsed.data.title);
    if (result.ok) return c.json(result.feed, 201);
    return result.code === 'duplicate'
      ? c.json({ error: 'That feed is already in your list', code: 'duplicate' }, 409)
      : c.json({ error: 'Feed limit reached — remove one first', code: 'limit' }, 409);
  });

  app.post('/feeds/:id/consent', guard, async (c) => {
    const parsed = FeedConsentRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
    const feed = await c.get('ws').feeds.setConsent(c.req.param('id'), parsed.data.enabled);
    return feed ? c.json(feed) : c.json({ error: 'No such feed', code: 'not_found' }, 404);
  });

  app.delete('/feeds/:id', guard, async (c) => {
    const result = await c.get('ws').feeds.remove(c.req.param('id'));
    if (result === 'ok') return c.json({ ok: true });
    return result === 'uni_feed'
      ? c.json({ error: 'University feeds come with your course — switch it off instead', code: 'uni_feed' }, 409)
      : c.json({ error: 'No such feed', code: 'not_found' }, 404);
  });

  return app;
}
