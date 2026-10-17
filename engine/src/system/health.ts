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

export const UNI_REACHABLE_TTL_MS = 20_000;

/**
 * Memoises a reachability probe per url for `ttlMs`, and shares one in-flight probe among
 * concurrent callers. The public health route uses it, so however often it is hit the engine
 * contacts the university at most once per TTL (each probe is bounded by the 2.5 s timeout).
 */
export function cachedReachability(probe: (url: string) => Promise<boolean>, ttlMs = UNI_REACHABLE_TTL_MS, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value?: boolean; pending?: Promise<boolean> }>();
  return (url: string): Promise<boolean> => {
    const hit = entries.get(url);
    if (hit?.pending) return hit.pending;
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value as boolean);
    const pending = probe(url).catch(() => false);
    entries.set(url, { at: now(), pending });
    void pending.then((value) => entries.set(url, { at: now(), value }));
    return pending;
  };
}
