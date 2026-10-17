import type { HealthResponse } from '@sef/shared';
import { checkRoles } from '../models/health';
import type { StoredSettings } from '../settings/store';
import { uniFetch } from '../uni/client';

export type RoleHealth = HealthResponse['models'][number];

export interface HealthProbe {
  uni: boolean;
  models: RoleHealth[];
}

export async function uniReachable(url: string): Promise<boolean> {
  try {
    await uniFetch(url, '/health', { timeoutMs: 2500 });
    return true;
  } catch {
    return false;
  }
}

/** The probe `/api/health` runs. Signals call the same function, so they reach no new destination. */
export async function probeHealth(settings: StoredSettings): Promise<HealthProbe> {
  const [uni, models] = await Promise.all([uniReachable(settings.uniServerUrl), checkRoles(settings)]);
  return { uni, models };
}
