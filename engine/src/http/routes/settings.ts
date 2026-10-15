import { Hono } from 'hono';
import { listProviderModels } from '../../models/health';
import { SettingsPatchSchema } from '../../settings/schema';
import { SettingsStore } from '../../settings/store';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/** Device-wide settings (servers, model providers). Only approved students may edit them. */
export function settingsRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });

  app.get('/settings', guard, async (c) => c.json(SettingsStore.redact(await c.get('ws').settings.get())));
  app.put('/settings', guard, async (c) => {
    const parsed = SettingsPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings', issues: parsed.error.issues }, 400);
    return c.json(SettingsStore.redact(await c.get('ws').settings.update(parsed.data)));
  });
  app.get('/providers/:id/models', guard, async (c) => {
    const provider = (await c.get('ws').settings.get()).providers.find((p) => p.id === c.req.param('id'));
    if (!provider) return c.json({ error: 'Unknown provider' }, 404);
    try {
      return c.json({ models: await listProviderModels(provider) });
    } catch (error) {
      return c.json({ models: [], error: friendlyError(error) });
    }
  });

  return app;
}
