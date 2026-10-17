import type { HealthResponse } from './api';

/**
 * Contracts for an engine reachable beyond loopback (a hosted seat). Additive: a local
 * engine answers the same shapes.
 */

/**
 * GET /api/health — unauthenticated, so it carries liveness plus one bare boolean: whether the
 * university server answers (the sign-in screen needs it before there is a session). No URL,
 * version, model or error text. The full report is /api/health/detail.
 */
export type HealthLiveness = Pick<HealthResponse, 'ok' | 'engine'> & { uni: Pick<HealthResponse['uni'], 'reachable'> };
