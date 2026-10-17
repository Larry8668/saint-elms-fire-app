import { z } from 'zod';
import type { HealthResponse } from './api';
import { LoginRequestSchema } from './auth';

/**
 * Contracts for an engine reachable beyond loopback (a hosted seat). Additive: a local
 * engine answers the same shapes.
 */

/** Short human name for the device a session was opened from; never an identifier. */
export const DeviceLabelSchema = z
  .string()
  .trim()
  .max(80)
  .transform((label) => label.replace(/[\u0000-\u001f\u007f]/g, ''));

/** POST /api/auth/login on the engine: the uni login body plus an optional device label. */
export const EngineLoginRequestSchema = LoginRequestSchema.extend({
  deviceLabel: DeviceLabelSchema.optional(),
});
export type EngineLoginRequest = z.infer<typeof EngineLoginRequestSchema>;

/** One of the signed-in profile's engine sessions. The token and its hash never leave the engine. */
export interface AuthSessionSummary {
  id: string;
  deviceLabel: string;
  mode: 'online' | 'offline';
  /** Null for sessions issued before the engine recorded it. */
  createdAt: string | null;
  /** Updated at most every few minutes, so it is a recency hint, not an audit trail. */
  lastSeenAt: string | null;
  expiresAt: string;
  /** True for the session that made this request. */
  current: boolean;
}

/** GET /api/auth/sessions */
export interface AuthSessionList {
  sessions: AuthSessionSummary[];
}

/** GET /api/health — unauthenticated liveness only; the full report is /api/health/detail. */
export type HealthLiveness = Pick<HealthResponse, 'ok' | 'engine'>;
