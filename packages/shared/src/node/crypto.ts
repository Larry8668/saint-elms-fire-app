import { createPublicKey, randomBytes, scrypt as scryptCb, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { promisify } from 'node:util';
import { ROLES, TOKEN_PREFIX, type TokenClaims } from '../auth';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 32;

/** `scrypt$<salt>$<hash>` — used for uni accounts and for the engine's offline verifier. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function signToken(claims: TokenClaims, privateKey: KeyObject): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(sign(null, Buffer.from(payload), privateKey));
  return `${TOKEN_PREFIX}.${payload}.${signature}`;
}

export class TokenError extends Error {}

/** Verifies signature and expiry. Throws TokenError with a reason a log can use. */
export function verifyToken(token: string, publicKeyPem: string, now = Date.now()): TokenClaims {
  const [prefix, payload, signature] = token.split('.');
  if (prefix !== TOKEN_PREFIX || !payload || !signature) throw new TokenError('malformed token');
  let ok = false;
  try {
    ok = verify(null, Buffer.from(payload), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new TokenError('bad signature');
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw new TokenError('malformed claims');
  }
  const validShape =
    typeof claims?.sub === 'string' && typeof claims.exp === 'number' && Number.isFinite(claims.exp) && (ROLES as readonly string[]).includes(claims.role);
  if (!validShape) throw new TokenError('malformed claims');
  if (claims.exp * 1000 < now) throw new TokenError('expired');
  return claims;
}
