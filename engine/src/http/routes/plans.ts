import { Hono, type Context } from 'hono';
import { CONTRACT_VERSION, CreatePlanRequestSchema, type PlansResponse } from '@sef/shared';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import type { PlanActionResult } from '../../plans/service';

const ACTION_STATUS = { not_found: 404, not_proposed: 409, not_open: 409, too_many_active: 409, nothing_left: 409 } as const;
const PROPOSE_STATUS = { planner_unavailable: 503, no_valid_steps: 422, goal_declined: 422, too_many_proposals: 409 } as const;

/** Study plans. Proposing calls the planner; approving only starts tracking — nothing is ever run. */
export function planRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  const respond = (c: Context<EngineEnv>, result: PlanActionResult) =>
    result.ok ? c.json(result.plan) : c.json({ error: result.message, code: result.code }, ACTION_STATUS[result.code]);

  app.get('/plans', guard, async (c) => {
    const body: PlansResponse = { schemaVersion: CONTRACT_VERSION, plans: await c.get('ws').plans.list() };
    return c.json(body);
  });

  app.post('/plans', guard, async (c) => {
    const parsed = CreatePlanRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid goal', issues: parsed.error.issues }, 400);
    const result = await c.get('ws').plans.propose(parsed.data);
    if (result.ok) return c.json(result.plan, 201);
    return c.json({ error: result.message, code: result.code, notes: result.notes }, PROPOSE_STATUS[result.code]);
  });

  app.get('/plans/:id', guard, async (c) => {
    const plan = await c.get('ws').plans.get(c.req.param('id'));
    return plan ? c.json(plan) : c.json({ error: 'No such plan', code: 'not_found' }, 404);
  });

  app.post('/plans/:id/approve', guard, async (c) => respond(c, await c.get('ws').plans.approve(c.req.param('id'))));
  app.post('/plans/:id/abandon', guard, async (c) => respond(c, await c.get('ws').plans.abandon(c.req.param('id'))));

  return app;
}
