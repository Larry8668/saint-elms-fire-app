import { Hono } from 'hono';
import { z } from 'zod';
import { LoginRequestSchema } from '@sef/shared';
import { AuthError } from '../../profiles/auth';
import { UniUnreachableError } from '../../uni/client';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';

const STATUS: Record<AuthError['code'], 400 | 401 | 403 | 503> = {
  invalid_credentials: 401,
  account_disabled: 403,
  offline_unknown_profile: 503,
  no_device_flow: 400,
  offline_locked: 401,
  staff_use_portal: 403,
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

  /** First-party sign-in: start an RFC 8628 device grant against the uni. */
  app.post('/device/start', async (c) => {
    try {
      return c.json(await deps.auth.startDeviceSignIn());
    } catch (error) {
      if (error instanceof UniUnreachableError) {
        return c.json({ error: 'The university server is unreachable. Device sign-in needs a connection.', code: 'uni_unreachable' }, 503);
      }
      throw error;
    }
  });

  /** One poll of the in-flight device grant; the UI repeats this on the returned interval. */
  app.post('/device/poll', async (c) => {
    try {
      return c.json(await deps.auth.pollDeviceSignIn());
    } catch (error) {
      if (error instanceof AuthError) return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
      if (error instanceof UniUnreachableError) {
        return c.json({ error: 'The university server is unreachable.', code: 'uni_unreachable' }, 503);
      }
      throw error;
    }
  });

  /**
   * Offline entry for a device-sign-in profile: the stored uni-signed entitlement is
   * verified locally. First-time users have no entitlement and cannot get in offline.
   */
  app.post('/offline-login', async (c) => {
    const parsed = z.object({ profileId: z.string().min(1).max(128) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Pick a profile', code: 'invalid_request' }, 400);
    try {
      const result = await deps.auth.unlockOffline(parsed.data.profileId);
      if (!result) return c.json({ error: 'Unknown profile', code: 'unauthenticated' }, 401);
      return c.json(result);
    } catch (error) {
      if (error instanceof AuthError) return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
      throw error;
    }
  });

  app.get('/me', requireProfile(deps), (c) => c.json(c.get('me')));

  /** Signing out is always allowed — a limited session must be able to end itself. */
  app.post('/logout', requireProfile(deps, { limitedWrites: true }), async (c) => {
    await deps.auth.logout(c.get('token'));
    deps.workspaces.drop(c.get('me').profile.id);
    return c.body(null, 204);
  });

  return app;
}
