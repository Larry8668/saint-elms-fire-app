import { Hono } from 'hono';
import { TeacherIdSchema } from '@sef/shared';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

/** Suggested questions per teacher. Read-only: a click is sent through the ordinary chat turn. */
export function suggestRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  app.get('/teachers/:teacher/suggestions', guard, async (c) => {
    const teacher = TeacherIdSchema.safeParse(c.req.param('teacher'));
    if (!teacher.success) return c.json({ error: 'Unknown teacher', code: 'unknown_teacher' }, 404);
    return c.json(await c.get('ws').suggestions.get(teacher.data));
  });

  return app;
}
