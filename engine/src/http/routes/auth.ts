import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { LoginRequestSchema } from '@sef/shared';
import { log } from '../../config';
import { AuthError } from '../../profiles/auth';
import { UniUnreachableError } from '../../uni/client';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { edgePolicy } from '../edge';
import { rateLimit, SlidingWindowLimiter } from '../rate-limit';

const STATUS: Record<AuthError['code'], 400 | 401 | 403 | 503> = {
  invalid_credentials: 401,
  account_disabled: 403,
  offline_unknown_profile: 503,
  no_device_flow: 400,
  offline_locked: 401,
  staff_use_portal: 403,
};

const MINUTE = 60_000;

/** Bad sign-ins are logged for the operator; never with the password, token or email. */
const AUTH_FAILURES = new Set<AuthError['code']>(['invalid_credentials', 'offline_unknown_profile', 'offline_locked']);

const PollBodySchema = z.object({ flowKey: z.string().min(1).max(128).optional() }).nullable();
const OfflineBodySchema = z.object({ profileId: z.string().min(1).max(128) });

export function authRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const edge = edgePolicy(process.env);
  // A hosted seat is reachable by anyone with its URL, and so is any engine a forwarded or
  // non-loopback request reaches: possession of the device proves nothing there, so the
  // profile picker, the password-less offline unlock and keyless device polls close.
  const remote = (c: Context<EngineEnv>) => edge.remote(c);

  // Guessing is limited per client across both sign-in routes (one shared budget); a
  // sign-in that succeeds refunds its attempt. Device polls carry no secret, so they are
  // only capped above the client's 2 s poll floor.
  const signInLimit = rateLimit(new SlidingWindowLimiter({ limit: 5, windowMs: MINUTE }), edge, true);
  const pollLimit = rateLimit(new SlidingWindowLimiter({ limit: 30, windowMs: MINUTE }), edge, false);

  const failed = (c: Context<EngineEnv>, error: AuthError, fields: Record<string, unknown> = {}) => {
    if (AUTH_FAILURES.has(error.code)) log.warn('auth_failed', { route: c.req.path, code: error.code, address: edge.client(c), ...fields });
    return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
  };

  /** Profiles on this device, for the sign-in picker. No secrets, works offline. */
  app.get('/profiles', async (c) => c.json(remote(c) ? [] : await deps.auth.profiles()));

  app.post('/login', signInLimit, async (c) => {
    const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Enter an email and password', code: 'invalid_request' }, 400);
    try {
      return c.json(await deps.auth.login(parsed.data.email, parsed.data.password));
    } catch (error) {
      if (error instanceof AuthError) return failed(c, error);
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
  app.post('/device/poll', pollLimit, async (c) => {
    const parsed = PollBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid poll', code: 'invalid_request' }, 400);
    try {
      return c.json(await deps.auth.pollDeviceSignIn({ flowKey: parsed.data?.flowKey, requireFlowKey: remote(c) }));
    } catch (error) {
      if (error instanceof AuthError) return failed(c, error);
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
  app.post('/offline-login', signInLimit, async (c) => {
    if (remote(c)) {
      return c.json({ error: 'Offline unlock is only available on the device itself. Sign in with your university account.', code: 'offline_unavailable' }, 403);
    }
    const parsed = OfflineBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Pick a profile', code: 'invalid_request' }, 400);
    try {
      const result = await deps.auth.unlockOffline(parsed.data.profileId);
      if (!result) {
        log.warn('auth_failed', { route: c.req.path, code: 'unknown_profile', address: edge.client(c) });
        return c.json({ error: 'Unknown profile', code: 'unauthenticated' }, 401);
      }
      return c.json(result);
    } catch (error) {
      if (error instanceof AuthError) return failed(c, error, { profileId: parsed.data.profileId });
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
