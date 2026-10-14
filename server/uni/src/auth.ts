import type { Context, MiddlewareHandler } from 'hono';
import type { Account, LoginResponse, Role, TokenClaims } from '@sef/shared';
import { signToken, TokenError, verifyToken } from '@sef/shared/node';
import { config } from './config';
import { log } from './logger';
import type { SigningKeys } from './signing';

export type AppEnv = { Variables: { claims: TokenClaims } };

export function issueToken(account: Account, keys: SigningKeys): LoginResponse {
  const hours = account.role === 'admin' ? config.adminTokenHours : config.studentTokenHours;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + hours * 3600;
  const claims: TokenClaims = {
    iss: config.issuer,
    sub: account.id,
    role: account.role,
    name: account.name,
    email: account.email,
    cohortId: account.cohortId,
    stage: account.stage,
    iat,
    exp,
  };
  return { token: signToken(claims, keys.privateKey), expiresAt: new Date(exp * 1000).toISOString(), account };
}

const bearer = (c: Context) => c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];

/** Rejects the request unless it carries a valid token for one of `roles`. */
export function requireRole(keys: SigningKeys, ...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);
    try {
      const claims = verifyToken(token, keys.publicKeyPem);
      if (!roles.includes(claims.role)) {
        log.warn('auth_forbidden', { sub: claims.sub, role: claims.role, path: c.req.path });
        return c.json({ error: 'forbidden' }, 403);
      }
      c.set('claims', claims);
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      log.warn('auth_token_rejected', { reason: error.message, path: c.req.path });
      return c.json({ error: 'unauthenticated', message: error.message }, 401);
    }
    await next();
  };
}
