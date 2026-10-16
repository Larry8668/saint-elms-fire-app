import { Hono } from 'hono';
import { LoginRequestSchema } from '@sef/shared';
import { issueToken, requireRole, type AppEnv } from '../auth';
import type { UniDeps } from '../deps';
import { createLoginRateLimit, logFingerprint } from '../login-rate-limit';
import { log } from '../logger';

export function authRoutes(deps: UniDeps) {
  const app = new Hono<AppEnv>();
  // The legacy login sits outside better-auth, so its limiter lives here instead.
  const loginRateLimit = createLoginRateLimit();

  app.post('/login', loginRateLimit, async (c) => {
    const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    const account = await deps.accounts.authenticate(parsed.data.email, parsed.data.password);
    if (!account) {
      log.warn('login_failed', { emailFingerprint: logFingerprint(parsed.data.email) });
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    await deps.audit.record(account.id, 'login', `${account.role} signed in`);
    return c.json(issueToken(account, deps.keys));
  });

  app.get('/me', requireRole(deps.keys, 'student', 'admin'), (c) => {
    const account = deps.accounts.get(c.get('claims').sub);
    if (!account || account.disabled) return c.json({ error: 'account_unavailable' }, 401);
    return c.json(account);
  });

  return app;
}
