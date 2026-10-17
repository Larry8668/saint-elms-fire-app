import { envInt } from '@sef/shared/node';

/**
 * Session orchestrator settings (docs/session-orchestrator.md has the table). The orchestrator
 * runs only when INSTABOX_API_KEY and SEF_GOLDEN_SNAPSHOT_ID are both set; otherwise the
 * session routes answer 503 and nothing touches Instabox.
 */
export interface SessionConfig {
  apiKey: string;
  apiBaseUrl?: string;
  snapshotId: string;
  maxConcurrent: number;
  idleMinutes: number;
  reaperIntervalMs: number;
  /** Instabox's own idle suspend on the session VM (120–86400, 0 = never). */
  autoSuspendSeconds: number;
  /** What the VM calls the university at (UNI_SERVER_URL on the box). */
  uniPublicUrl: string;
  gatewayUrl: string;
  gatewaySecret: string | null;
  gatewayTokenMinutes: number;
  /** OBJECT_STORE_* passed through to the VM for vault sync (PR-41); empty values are dropped. */
  objectStore: Record<string, string>;
  /** Where the golden snapshot keeps the session scripts (infra/seat/bootstrap.sh SEAT_HOME). */
  seatHome: string;
  timeouts: StepTimeouts;
  /** How long a spawn keeps retrying no_capacity / quota before it fails. */
  capacityWaitMs: number;
  retryBaseMs: number;
  /**
   * Origins the portal page may read a workspace's public health from (its CSP connect-src),
   * so the browser can see the VM answer before it is handed there. Optional for tests.
   */
  workspaceOrigins?: string[];
}

/** https on any host (one leading `*.` label allowed), or http on loopback for a local engine under test. */
const WORKSPACE_ORIGIN = /^(https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*|http:\/\/(127\.0\.0\.1|localhost))(:\d{1,5})?$/i;

export function parseWorkspaceOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? 'https://*.instabox.tech').split(/[\s,]+/).filter(Boolean);
  for (const origin of origins) {
    if (!WORKSPACE_ORIGIN.test(origin)) throw new Error(`SESSION_WORKSPACE_ORIGINS: ${JSON.stringify(origin)} is not an https origin (or http on loopback)`);
  }
  return origins;
}

export interface StepTimeouts {
  create: number;
  start: number;
  publish: number;
  sessionStart: number;
  health: number;
  flush: number;
  delete: number;
}

export const OBJECT_STORE_KEYS = [
  'OBJECT_STORE_ENDPOINT',
  'OBJECT_STORE_REGION',
  'OBJECT_STORE_BUCKET',
  'OBJECT_STORE_ACCESS_KEY',
  'OBJECT_STORE_SECRET_KEY',
  'OBJECT_STORE_FORCE_PATH_STYLE',
] as const;

const value = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || undefined;

export function parseSessionConfig(env: NodeJS.ProcessEnv = process.env, uniPublicUrl = env.UNI_PUBLIC_URL?.trim() || 'http://localhost:4200'): SessionConfig | null {
  const apiKey = value(env, 'INSTABOX_API_KEY');
  const snapshotId = value(env, 'SEF_GOLDEN_SNAPSHOT_ID');
  if (!apiKey || !snapshotId) return null;
  if (!/^(sn|im)_[a-z0-9]{1,64}$/.test(snapshotId)) throw new Error('SEF_GOLDEN_SNAPSHOT_ID is not a snapshot id');
  const gatewaySecret = value(env, 'GATEWAY_TOKEN_SECRET') ?? null;
  if (gatewaySecret && Buffer.byteLength(gatewaySecret) < 32) throw new Error('GATEWAY_TOKEN_SECRET must be at least 32 bytes');
  if (!gatewaySecret && env.NODE_ENV === 'production') throw new Error('GATEWAY_TOKEN_SECRET is required with the session orchestrator in production');
  const autoSuspendSeconds = envInt('SESSION_AUTO_SUSPEND_SECONDS', 1800, { min: 0, max: 86_400 }, env);
  if (autoSuspendSeconds > 0 && autoSuspendSeconds < 120) throw new Error('SESSION_AUTO_SUSPEND_SECONDS must be 0 or 120-86400');
  const objectStore: Record<string, string> = {};
  for (const key of OBJECT_STORE_KEYS) {
    const v = value(env, key);
    if (v) objectStore[key] = v;
  }
  return {
    apiKey,
    apiBaseUrl: value(env, 'INSTABOX_API_URL'),
    snapshotId,
    // Quota is 5 machines on the account and the operator's own box takes one: 3 leaves a spare.
    maxConcurrent: envInt('SESSION_MAX_CONCURRENT', 3, { min: 1, max: 1000 }, env),
    idleMinutes: envInt('SESSION_IDLE_MINUTES', 15, { min: 1, max: 24 * 60 }, env),
    reaperIntervalMs: envInt('SESSION_REAPER_INTERVAL_SECONDS', 30, { min: 1, max: 3600 }, env) * 1000,
    autoSuspendSeconds,
    uniPublicUrl: uniPublicUrl.replace(/\/+$/, ''),
    gatewayUrl: value(env, 'MODEL_GATEWAY_URL') ?? 'https://gateway.invalid/v1',
    gatewaySecret,
    gatewayTokenMinutes: envInt('MODEL_GATEWAY_TOKEN_MINUTES', 8 * 60, { min: 5, max: 24 * 60 }, env),
    objectStore,
    seatHome: '/data/home/sef-seat',
    timeouts: {
      create: 120_000,
      start: 90_000,
      publish: 30_000,
      sessionStart: 75_000,
      health: envInt('SESSION_HEALTH_TIMEOUT_SECONDS', 180, { min: 5, max: 3600 }, env) * 1000,
      flush: 75_000,
      delete: 60_000,
    },
    capacityWaitMs: envInt('SESSION_CAPACITY_WAIT_SECONDS', 600, { min: 0, max: 86_400 }, env) * 1000,
    retryBaseMs: 2_000,
    workspaceOrigins: parseWorkspaceOrigins(value(env, 'SESSION_WORKSPACE_ORIGINS')),
  };
}
