import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Model gateway bearer tokens (docs/model-gateway.md). The session orchestrator (PR-42)
 * mints them; the gateway (server/gateway) verifies them. The wire format is the contract:
 *
 *   token   = "sefgw1." + base64url(claimsJson) + "." + base64url(mac)
 *   claims  = {"sub": accountId, "vm"?: machineId, "exp": unixSeconds}   (JSON, UTF-8)
 *   mac     = HMAC-SHA256(key = GATEWAY_TOKEN_SECRET as UTF-8, data = "sefgw1." + base64url(claimsJson))
 *
 * base64url is unpadded (RFC 4648 section 5). `exp` is whole seconds since the epoch, and
 * a token may live at most GATEWAY_TOKEN_MAX_TTL_SECONDS. `sub`/`vm` are 1-128 chars of
 * [A-Za-z0-9_.:@-]. There are no scopes yet: every valid token may use the allowlisted models.
 */
export interface GatewayClaims {
  /** The account id the usage counts against. */
  sub: string;
  /** The VM (machine id) the token was minted for, when there is one. */
  vm?: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export type GatewayTokenVerifyResult = { ok: true; claims: GatewayClaims; dev: boolean } | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' };

const PREFIX = 'sefgw1';
/** Hard ceiling on a token's lifetime, so a leaked token cannot outlive a long exam week. */
export const GATEWAY_TOKEN_MAX_TTL_SECONDS = 7 * 24 * 3600;
const SUB_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(`${PREFIX}.${body}`).digest();

export function mintGatewayToken(secret: string, claims: { sub: string; vm?: string; ttlSeconds: number }, nowMs = Date.now()): string {
  if (secret.length < 32) throw new Error('GATEWAY_TOKEN_SECRET must be at least 32 characters');
  if (!SUB_PATTERN.test(claims.sub) || (claims.vm !== undefined && !SUB_PATTERN.test(claims.vm))) throw new Error('sub/vm must be short ids');
  if (!(claims.ttlSeconds > 0 && claims.ttlSeconds <= GATEWAY_TOKEN_MAX_TTL_SECONDS)) throw new Error(`ttlSeconds must be 1..${GATEWAY_TOKEN_MAX_TTL_SECONDS}`);
  const payload: GatewayClaims = { sub: claims.sub, ...(claims.vm ? { vm: claims.vm } : {}), exp: Math.floor(nowMs / 1000) + claims.ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${PREFIX}.${body}.${sign(secret, body).toString('base64url')}`;
}

/** Dev tokens: `token` or `token:subject`, compared by hash so lengths never leak through timing. */
export interface GatewayDevToken {
  digest: Buffer;
  sub: string;
}

export function parseGatewayDevTokens(raw: string | undefined): GatewayDevToken[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const at = entry.indexOf(':');
      const token = at >= 0 ? entry.slice(0, at) : entry;
      const sub = at >= 0 ? entry.slice(at + 1) : `dev-${index + 1}`;
      if (token.length < 16) throw new Error('GATEWAY_DEV_TOKENS entries must be at least 16 characters');
      if (!SUB_PATTERN.test(sub)) throw new Error('GATEWAY_DEV_TOKENS subject must be a short id');
      return { digest: createHash('sha256').update(token).digest(), sub };
    });
}

export function verifyGatewayToken(header: string | undefined, opts: { secret?: string; devTokens: GatewayDevToken[]; nowMs?: number }): GatewayTokenVerifyResult {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match) return { ok: false, reason: header ? 'malformed' : 'missing' };
  const token = match[1];

  if (opts.devTokens.length) {
    const digest = createHash('sha256').update(token).digest();
    // Check every entry (no early exit) so the position of a match is not observable.
    let hit: GatewayDevToken | undefined;
    for (const dev of opts.devTokens) if (timingSafeEqual(dev.digest, digest)) hit = dev;
    if (hit) return { ok: true, claims: { sub: hit.sub, exp: Number.MAX_SAFE_INTEGER }, dev: true };
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !opts.secret) return { ok: false, reason: 'malformed' };
  const [, body, sig] = parts;
  const expected = sign(opts.secret, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const c = claims as Partial<GatewayClaims>;
  if (
    !c ||
    typeof c.sub !== 'string' ||
    !SUB_PATTERN.test(c.sub) ||
    (c.vm !== undefined && (typeof c.vm !== 'string' || !SUB_PATTERN.test(c.vm))) ||
    typeof c.exp !== 'number' ||
    !Number.isSafeInteger(c.exp)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const now = opts.nowMs ?? Date.now();
  if (c.exp * 1000 <= now) return { ok: false, reason: 'expired' };
  // A validly signed token claiming more than the lifetime ceiling was not minted by mintGatewayToken.
  if (c.exp * 1000 > now + (GATEWAY_TOKEN_MAX_TTL_SECONDS + 60) * 1000) return { ok: false, reason: 'malformed' };
  return { ok: true, claims: { sub: c.sub, ...(c.vm ? { vm: c.vm } : {}), exp: c.exp }, dev: false };
}
