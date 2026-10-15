import { ACCOUNT_BASE, contractError, getJson, sendJson } from './http';
import { readAuthSession, readTwoFactorChallenge, type AuthSession } from './guards';

/**
 * Staff sign-in against the university's own account endpoints, same origin so the HttpOnly
 * session cookie is set and sent by the browser. Endpoint shapes verified against the pinned
 * better-auth 1.7.7 build:
 *
 *   POST /v1/auth/sign-in/email        { email, password, rememberMe? }
 *     → 200 session, or { twoFactorRedirect: true, twoFactorMethods: ['totp'] }
 *   POST /v1/auth/two-factor/verify-totp  { code, trustDevice? }
 *   POST /v1/auth/sign-out            {}
 *   GET  /v1/auth/get-session         → { session, user } | null
 *
 * The uni mounts these under `/v1/auth` (`basePath` in `server/uni/src/account-auth.ts`) and
 * configures the `twoFactor` plugin, so an MFA staff account is answered with a challenge
 * rather than a session.
 */

/** Where the account layer should return a browser to: this app, not the student portal. */
const RETURN_PATH = '/admin';

export const getAuthSession = async (): Promise<AuthSession | null> => {
  const raw = await getJson(`${ACCOUNT_BASE}/get-session`);
  // `null` is the documented no-session answer and must not be treated as an unreadable payload.
  if (raw === null || raw === undefined) return null;
  const session = readAuthSession(raw);
  if (!session) throw contractError('a session record');
  return session;
};

export type SignInOutcome = { kind: 'signed-in' } | { kind: 'two-factor'; methods: string[] };

export const signInWithPassword = async (email: string, password: string): Promise<SignInOutcome> => {
  const raw = await sendJson(`${ACCOUNT_BASE}/sign-in/email`, 'POST', { email, password, rememberMe: true });
  const challenge = readTwoFactorChallenge(raw);
  if (challenge) return { kind: 'two-factor', methods: challenge.methods };
  if (!isSignInResponse(raw)) throw contractError('a sign-in response');
  return { kind: 'signed-in' };
};

/** TOTP is the only 2FA method this server can issue: `twoFactor()` is configured without `otpOptions.sendOTP`. */
export const verifyTwoFactor = async (code: string): Promise<void> => {
  await sendJson(`${ACCOUNT_BASE}/two-factor/verify-totp`, 'POST', { code, trustDevice: false });
};

export const signOut = async (): Promise<void> => {
  await sendJson(`${ACCOUNT_BASE}/sign-out`, 'POST', {});
  // The cookie is the session. If it is still there after a sign-out, the shell must not keep
  // showing staff records, so the caller refetches and fails closed on a surviving session.
};

const isSignInResponse = (raw: unknown): boolean => {
  if (typeof raw !== 'object' || raw === null) return false;
  const value = raw as { user?: { id?: unknown }; redirect?: unknown; token?: unknown; url?: unknown };
  return typeof value.user?.id === 'string' && Boolean(value.redirect || value.token || value.url);
};

export { RETURN_PATH };