import { ENGINE_AUDIENCE, EntitlementRequestSchema, type EntitlementResponse, type TokenClaims } from '@sef/shared';
import { TokenError, verifyToken } from '@sef/shared/node';
import { log } from '../config';
import { uniFetch } from './client';
import { pinnedUniKey } from './trust';

/** Asks the uni for a fresh device-bound offline entitlement. Online only. */
export async function fetchEntitlement(uniUrl: string, sessionToken: string, dev: string): Promise<EntitlementResponse> {
  const body = EntitlementRequestSchema.parse({ deviceId: dev });
  return uniFetch<EntitlementResponse>(uniUrl, '/v1/entitlement', { method: 'POST', token: sessionToken, body });
}

export interface VerifiedEntitlement {
  claims: TokenClaims;
  expiresAt: Date;
}

export type EntitlementRejectReason = 'signature' | 'audience' | 'profile' | 'device' | 'expired' | 'no_key';

/**
 * Verifies an offline entitlement entirely locally: ed25519 signature against the
 * pinned uni key, plus audience, student, device and expiry checks. Returns the
 * verified claims or a reason string — never throws.
 */
export function verifyEntitlement(
  token: string,
  publicKeyPem: string | null,
  expected: { profileId: string; deviceId: string },
  now = new Date(),
): { ok: true; entitlement: VerifiedEntitlement } | { ok: false; reason: EntitlementRejectReason } {
  if (!publicKeyPem) return { ok: false, reason: 'no_key' };
  let claims: TokenClaims;
  try {
    claims = verifyToken(token, publicKeyPem, now.getTime());
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    const reason = error.message === 'expired' ? 'expired' : 'signature';
    log.warn('entitlement_rejected', { reason, detail: error.message });
    return { ok: false, reason };
  }
  if (claims.aud !== ENGINE_AUDIENCE) return { ok: false, reason: 'audience' };
  if (claims.sub !== expected.profileId) return { ok: false, reason: 'profile' };
  if (claims.dev !== expected.deviceId) return { ok: false, reason: 'device' };
  const expiresAt = new Date(claims.exp * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, entitlement: { claims, expiresAt } };
}

/** Offline path: verifies with the pinned key only. Null when nothing is pinned yet. */
export async function verifyEntitlementOffline(
  token: string,
  expected: { profileId: string; deviceId: string },
  now = new Date(),
) {
  return verifyEntitlement(token, await pinnedUniKey(), expected, now);
}
