import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { DeviceLabelSchema, EngineLoginRequestSchema, type AuthSessionList } from '@sef/shared';
import { config, log } from '../../config';
import { AuthError } from '../../profiles/auth';
import { UniUnreachableError } from '../../uni/client';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { edgePolicy } from '../edge';
import { rateLimit, SlidingWindowLimiter } from '../rate-limit';
import { deviceLabelFor } from '../user-agent';

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

/** One shared bucket for the whole engine. */
const ENGINE_WIDE = { client: () => 'engine' };

const PollBodySchema = z.object({ flowKey: z.string().min(1).max(128).optional(), deviceLabel: DeviceLabelSchema.optional() }).nullable();
const OfflineBodySchema = z.object({ profileId: z.string().min(1).max(128), deviceLabel: DeviceLabelSchema.optional() });

export function authRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const edge = edgePolicy(process.env, config.port);
  // A hosted seat is reachable by anyone with its URL, and so is any engine a forwarded or
  // non-loopback request reaches: possession of the device proves nothing there, so the
  // profile picker, the password-less offline unlock and keyless device polls close.
  const remote = (c: Context<EngineEnv>) => edge.remote(c);

  // Guessing is limited per client across both sign-in routes (one shared budget); a
  // sign-in that succeeds refunds its attempt. Device polls carry no secret, so they are
  // only capped above the client's 2 s poll floor.
  const signInLimit = rateLimit(new SlidingWindowLimiter({ limit: 5, windowMs: MINUTE }), edge, true);
  // Password sign-ins are forwarded to the uni, whose own limiter (10/min) keys on this
  // engine's egress address: an engine-wide cap below it keeps a handful of attacker
  // addresses from exhausting the uni's budget for every student here. Successes refund.
  const loginGlobalLimit = rateLimit(new SlidingWindowLimiter({ limit: 8, windowMs: MINUTE }), ENGINE_WIDE, true);
  const pollLimit = rateLimit(new SlidingWindowLimiter({ limit: 30, windowMs: MINUTE }), edge, false);
  // Every device start is an upstream /v1/auth/device/code call: a few per client, and a
  // small cap for the whole engine so many addresses cannot amplify into the uni either.
  const startLimit = rateLimit(new SlidingWindowLimiter({ limit: 5, windowMs: MINUTE }), edge, false);
  const startGlobalLimit = rateLimit(new SlidingWindowLimiter({ limit: 20, windowMs: MINUTE }), ENGINE_WIDE, false);

  const failed = (c: Context<EngineEnv>, error: AuthError, fields: Record<string, unknown> = {}) => {
    if (AUTH_FAILURES.has(error.code)) log.warn('auth_failed', { route: c.req.path, code: error.code, address: edge.client(c), ...fields });
    return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
  };

  /** Profiles on this device, for the sign-in picker. No secrets, works offline. */
  app.get('/profiles', async (c) => c.json(remote(c) ? [] : await deps.auth.profiles()));

  app.post('/login', signInLimit, loginGlobalLimit, async (c) => {
    const parsed = EngineLoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Enter an email and password', code: 'invalid_request' }, 400);
    try {
      const label = parsed.data.deviceLabel || deviceLabelFor(c.req.header('user-agent'));
      return c.json(await deps.auth.login(parsed.data.email, parsed.data.password, label));
    } catch (error) {
      if (error instanceof AuthError) return failed(c, error);
      throw error;
    }
  });

  /** First-party sign-in: start an RFC 8628 device grant against the uni. */
  app.post('/device/start', startLimit, startGlobalLimit, async (c) => {
    try {
      return c.json(await deps.auth.startDeviceSignIn({ allowKeyless: !remote(c) }));
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
      return c.json(
        await deps.auth.pollDeviceSignIn({
          flowKey: parsed.data?.flowKey,
          requireFlowKey: remote(c),
          deviceLabel: parsed.data?.deviceLabel || deviceLabelFor(c.req.header('user-agent')),
        }),
      );
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
      const result = await deps.auth.unlockOffline(parsed.data.profileId, parsed.data.deviceLabel || deviceLabelFor(c.req.header('user-agent')));
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

  /** The signed-in profile's own sessions on this engine; tokens and their hashes never leave it. */
  app.get('/sessions', requireProfile(deps), async (c) => {
    const body: AuthSessionList = { sessions: await deps.auth.listSessions(c.get('me').profile.id, c.get('token')) };
    return c.json(body);
  });

  /** Revoking a lost device is a safety action, so a limited session may do it too. */
  app.delete('/sessions/:id', requireProfile(deps, { limitedWrites: true }), async (c) => {
    const id = c.req.param('id');
    if (id.length > 64 || !(await deps.auth.revokeSession(c.get('me').profile.id, id))) {
      return c.json({ error: 'No such session', code: 'not_found' }, 404);
    }
    return c.body(null, 204);
  });

  /** Signing out is always allowed — a limited session must be able to end itself. */
  app.post('/logout', requireProfile(deps, { limitedWrites: true }), async (c) => {
    await deps.auth.logout(c.get('token'));
    deps.workspaces.drop(c.get('me').profile.id);
    return c.body(null, 204);
  });

  return app;
}
