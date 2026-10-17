import { Hono } from 'hono';
import { RecordMetricsRequestSchema } from '@sef/shared';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

/** Local evaluation counters. Profile-scoped; nothing here is exported or sent anywhere. */
export function metricsRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  app.get('/metrics', guard, async (c) => c.json(await c.get('ws').metrics.report()));

  app.post('/metrics/events', guard, async (c) => {
    const parsed = RecordMetricsRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid metric events', issues: parsed.error.issues }, 400);
    return c.json({ recorded: await c.get('ws').metrics.recordClient(parsed.data) }, 202);
  });

  return app;
}
