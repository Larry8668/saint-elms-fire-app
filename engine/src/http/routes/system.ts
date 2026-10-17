import { Hono } from 'hono';
import type { DeviceCapability } from '@sef/shared';
import { detectCapability } from '../../system/capability';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

/** Device facts behind the Settings recommendation card. Detected once per engine process. */
export function systemRoutes(deps: EngineDeps, detect: () => Promise<DeviceCapability> = detectCapability) {
  const app = new Hono<EngineEnv>();
  const guard = requireProfile(deps, { approved: true });
  let capability: Promise<DeviceCapability> | null = null;

  app.get('/system/capability', guard, async (c) => {
    capability ??= detect();
    return c.json(await capability);
  });

  return app;
}
