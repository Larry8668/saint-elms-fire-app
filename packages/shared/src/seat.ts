import type { HealthResponse } from './api';

/**
 * Contracts for an engine reachable beyond loopback (a hosted seat). Additive: a local
 * engine answers the same shapes.
 */

/** GET /api/health — unauthenticated liveness only; the full report is /api/health/detail. */
export type HealthLiveness = Pick<HealthResponse, 'ok' | 'engine'>;
