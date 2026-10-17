import { Hono } from 'hono';
import { SeenRequestSchema, SnoozeRequestSchema } from '@sef/shared';
import type { SignalActionResult } from '../../signals/service';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

/** The student's attention items. Dismiss/snooze/seen are local bookkeeping, so limited access may use them. */
export function attentionRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true, limitedWrites: true });
  const answer = (result: SignalActionResult) => (result === 'ok' ? { ok: true } : null);

  app.get('/attention', guard, async (c) => c.json(await c.get('ws').signals.list()));

  app.post('/attention/evaluate', guard, async (c) => {
    const signals = c.get('ws').signals;
    await signals.evaluate();
    return c.json(await signals.view());
  });

  app.post('/attention/seen', guard, async (c) => {
    const parsed = SeenRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
    return c.json({ updated: await c.get('ws').signals.markSeen(parsed.data.keys) });
  });

  app.post('/attention/:key/dismiss', guard, async (c) => {
    const body = answer(await c.get('ws').signals.dismiss(c.req.param('key')));
    return body ? c.json(body) : c.json({ error: 'No such attention item', code: 'not_found' }, 404);
  });

  app.post('/attention/:key/snooze', guard, async (c) => {
    const parsed = SnoozeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Snooze for 1 to 168 hours', issues: parsed.error.issues }, 400);
    const body = answer(await c.get('ws').signals.snooze(c.req.param('key'), parsed.data.hours));
    return body ? c.json(body) : c.json({ error: 'No such attention item', code: 'not_found' }, 404);
  });

  return app;
}
