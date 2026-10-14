import { Hono } from 'hono';
import { LoginRequestSchema } from '@sef/shared';
import { AuthError } from '../../profiles/auth';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

const STATUS: Record<AuthError['code'], 401 | 403 | 503> = {
  invalid_credentials: 401,
  account_disabled: 403,
  offline_unknown_profile: 503,
};

export function authRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();

  /** Profiles on this device, for the sign-in picker. No secrets, works offline. */
  app.get('/profiles', async (c) => c.json(await deps.auth.profiles()));

  app.post('/login', async (c) => {
    const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Enter an email and password', code: 'invalid_request' }, 400);
    try {
      return c.json(await deps.auth.login(parsed.data.email, parsed.data.password));
    } catch (error) {
      if (error instanceof AuthError) return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
      throw error;
    }
  });

  app.get('/me', requireProfile(deps), (c) => c.json(c.get('me')));

  app.post('/logout', requireProfile(deps), async (c) => {
    await deps.auth.logout(c.get('token'));
    return c.body(null, 204);
  });

  return app;
}
