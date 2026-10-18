import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { bearer, deviceAuthorization, magicLink, twoFactor } from 'better-auth/plugins';
import type { Pool } from 'pg';
import type { Mailer } from './mail';
import { withStaffDeviceApprovalRefusal } from './device-approval';
import { createPgSecondaryStorage, type SecondaryStorage } from './rate-limit';
import { withMagicLinkConfirmation } from './routes/account';
import { log } from './logger';

export interface AccountAuthOptions {
  pool: Pool;
  mail: Mailer;
  /** Public origin of the university server; used for links and trusted-origin checks. */
  publicUrl: string;
  secret: string;
  trustedOrigins?: string[];
}

export interface SessionInfo {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  session: { id: string; createdAt: Date } | null;
}

export interface AccountAuth {
  handler: (request: Request) => Promise<Response>;
  storage: SecondaryStorage;
  trustedOrigins: readonly string[];
  /** Resolves the caller's session (cookie or bearer plugin token); null when absent. */
  getSession: (headers: Headers) => Promise<SessionInfo | null>;
  /**
   * Destroys every session for the account. Sessions live in secondary storage
   * (`auth_kv`) with `session` rows as the DB mirror, so this must go through the
   * auth adapter — deleting `session` rows alone leaves the cached copies alive.
   */
  revokeUserSessions: (userId: string) => Promise<void>;
}

/** The task scope pins 15-minute magic tokens. */
export const MAGIC_LINK_TTL_SECONDS = 900;

/**
 * The magic-link plugin emails a GET URL that consumes the token on first visit. Mail scanners
 * (and link prefetchers) issue exactly that request, which would burn the token before the
 * student clicks. The emailed link therefore points here instead — a non-consuming page — and the
 * student's own click performs the single-use verification. Same query string, different path.
 */
export function confirmationUrl(verifyUrl: string): string {
  const url = new URL(verifyUrl);
  url.pathname = '/v1/auth/magic-link/confirm';
  return url.toString();
}

/** Better-auth messages can embed request data; only a fixed message reaches the logger. */
export function redactSecrets(_message: string): string {
  return 'Authentication library reported an error';
}

export function resolveAccountAuthSecret(environment: NodeJS.ProcessEnv = process.env): string {
  const secret = environment.BETTER_AUTH_SECRET?.trim();
  if (secret) {
    if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
    return secret;
  }
  if (environment.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET is required in production');
  }
  log.warn('account_auth_dev_secret', { note: 'BETTER_AUTH_SECRET is not set; using a development-only secret' });
  return 'saint-elms-development-only-secret-0000000000';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function accountAuthOrigins(
  publicUrl: string,
  trustedOrigins: string[] = [],
  production = process.env.NODE_ENV === 'production',
): string[] {
  const origins: string[] = [];
  for (const [index, entry] of [publicUrl, ...trustedOrigins].entries()) {
    const field = index === 0 ? 'UNI_PUBLIC_URL' : 'UNI_TRUSTED_ORIGINS';
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${field} contains an invalid URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`${field} origins must use http or https`);
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${field} origins must be bare origins without credentials, path, query or fragment`);
    }
    if (production && url.protocol !== 'https:') {
      throw new Error(`${field} requires https origins in production`);
    }
    if (!production && url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error(`${field} http origins must be loopback in development`);
    }
    origins.push(url.origin);
  }
  return [...new Set(origins)];
}

/**
 * Options for the pinned better-auth release. Exported so schema tooling and tests exercise the
 * exact configuration the server runs.
 */
/**
 * better-auth runs every mail callback through `runInBackgroundOrAwait`, which logs a thrown
 * error and carries on, so a failed send still answers 200 and the portal said "Sent". The
 * callbacks record the failure here instead, and the handler reports it to the caller.
 */
const mailDelivery = new AsyncLocalStorage<{ failed: boolean }>();
export const MAIL_DELIVERY_HEADER = 'x-mail-delivery';

async function deliver(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    const scope = mailDelivery.getStore();
    if (scope) scope.failed = true;
    throw error;
  }
}

/** Marks the response `x-mail-delivery: failed` when any mail sent while serving it failed. */
export function withMailDeliveryReport(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    const scope = { failed: false };
    const response = await mailDelivery.run(scope, () => handler(request));
    if (!scope.failed) return response;
    const headers = new Headers(response.headers);
    headers.set(MAIL_DELIVERY_HEADER, 'failed');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

export function accountAuthOptions({ pool, mail, publicUrl, secret, trustedOrigins = [] }: AccountAuthOptions) {
  return {
    basePath: '/v1/auth',
    baseURL: publicUrl,
    secret,
    database: pool,
    trustedOrigins: accountAuthOrigins(publicUrl, trustedOrigins),
    logger: {
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
        if (level === 'error') log.error('better_auth', { message: redactSecrets(message) });
      },
    },
    advanced: {
      useSecureCookies: new URL(publicUrl).protocol === 'https:',
    },
    verification: {
      storeIdentifier: 'hashed',
    },
    emailAndPassword: {
      enabled: true,
      // Registration alone grants nothing: the account must verify its email, and admission is a
      // separate decision (PR-05). Duplicate sign-ups answer generically while this is on.
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await deliver(() => mail.sendPasswordReset(user.email, url));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        await deliver(() => mail.sendVerificationEmail(user.email, url));
      },
    },
    session: {
      // The database stays the source of truth even though a secondary store backs rate limits.
      storeSessionInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      // The pinned release supports `memory | secondary-storage`; `auth_kv` backs it in PostgreSQL.
      storage: 'secondary-storage',
      window: 60,
      max: 120,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 300, max: 5 },
        '/send-verification-email': { window: 300, max: 5 },
      },
    },
    secondaryStorage: createPgSecondaryStorage(pool),
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          await deliver(() => mail.sendMagicLink(email, confirmationUrl(url)));
        },
      }),
      // Device sign-in and staff MFA primitives are configured now; PR-07 and PR-10 build the flows.
      deviceAuthorization(),
      twoFactor({ issuer: 'Saint Elms University' }),
      bearer(),
    ],
  } satisfies Parameters<typeof betterAuth>[0];
}

export function createAccountAuth(options: AccountAuthOptions): AccountAuth {
  const storage = createPgSecondaryStorage(options.pool);
  const auth = betterAuth(accountAuthOptions(options));
  const origins = accountAuthOrigins(options.publicUrl, options.trustedOrigins ?? []);
  const getSession = async (headers: Headers): Promise<SessionInfo | null> => {
    const session = await auth.api.getSession({ headers });
    return session ? { user: session.user, session: session.session } : null;
  };
  log.info('account_auth_ready', { magicLinkTtlSeconds: MAGIC_LINK_TTL_SECONDS });
  return {
    handler: withStaffDeviceApprovalRefusal(
      withMagicLinkConfirmation(withMailDeliveryReport((request: Request) => auth.handler(request)), origins[0]),
      { pool: options.pool, getSession },
    ),
    storage,
    trustedOrigins: origins,
    getSession,
    revokeUserSessions: async (userId) => {
      const context = await (auth as unknown as {
        $context: Promise<{ internalAdapter: { deleteUserSessions: (id: string) => Promise<unknown> } }>;
      }).$context;
      await context.internalAdapter.deleteUserSessions(userId);
    },
  };
}
