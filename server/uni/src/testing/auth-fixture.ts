// Shared harness for the disposable-Postgres integration tests
// (`pnpm --filter @sef/uni-server db:test:integration`). Spins up a schema-scoped
// pool, migrates it, captures mail, and exposes the request helpers both suites use.
// Not a test file: it is only imported by *.test.ts, which the runner invokes.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Pool } from 'pg';
import type { Transporter } from 'nodemailer';
import { createAccountAuth, type AccountAuth } from '../account-auth';
import { closeDatabasePool, createDatabasePool, parseDatabaseConfig } from '../db';
import { migrateDatabase } from '../db/migrate';
import { createMailer } from '../mail';

const testDatabaseUrl = process.env.UNI_DB_TEST_RUNNER === 'compose-ephemeral'
  ? process.env.UNI_TEST_DATABASE_URL
  : undefined;
export const testOptions = { skip: !testDatabaseUrl };

export const ORIGIN = 'http://localhost:4200';
export const PASSWORD = 'correct-horse-battery-staple';
export const SECRET = 'integration-test-secret-0123456789-0123456789';

export interface CapturedMail {
  to: string;
  subject: string;
  text: string;
}

export interface AuthContext {
  pool: ReturnType<typeof createDatabasePool>;
  captured: CapturedMail[];
  app: Hono;
  auth: AccountAuth;
  makeAuth: () => AccountAuth;
  origin: string;
}

export function safeTestDatabaseUrl(): string {
  assert.ok(testDatabaseUrl, 'UNI_TEST_DATABASE_URL is required');
  const url = new URL(testDatabaseUrl);
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/sef_uni_test');
  assert.ok(Number(url.port) >= 1024);
  return testDatabaseUrl;
}

export interface AuthFixtureOptions {
  origin?: string;
  /** Extra route mounting beyond `/v1/auth/*` — e.g. me/staff routers under test. */
  mount?: (app: Hono, auth: AccountAuth) => void;
}

export async function withAuthSchema(
  run: (context: AuthContext) => Promise<void>,
  options: AuthFixtureOptions = {},
): Promise<void> {
  const publicOrigin = options.origin ?? ORIGIN;
  const url = safeTestDatabaseUrl();
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  const schema = `sef_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createDatabasePool(parseDatabaseConfig({ UNI_DATABASE_URL: scopedUrl.toString() }));
  try {
    await migrateDatabase(pool);
    const captured: CapturedMail[] = [];
    const transport = {
      sendMail: async (opts: CapturedMail) => {
        captured.push(opts);
        return { accepted: [opts.to] };
      },
    } as unknown as Transporter;
    const mail = createMailer({ smtpUrl: 'smtp://127.0.0.1:1025', from: 'Sef Test <test@saintelms.test>' }, transport);
    const makeAuth = () => createAccountAuth({ pool, mail, publicUrl: publicOrigin, secret: SECRET });
    const accountAuth = makeAuth();
    // Mirror the server's mounting: the wrapper lives inside the account handler itself.
    const app = new Hono();
    app.all('/v1/auth/*', (c) => accountAuth.handler(c.req.raw));
    options.mount?.(app, accountAuth);
    await run({ pool, captured, app, auth: accountAuth, makeAuth, origin: publicOrigin });
  } finally {
    await closeDatabasePool(pool);
  }
}

export const authRequest = (context: AuthContext, url: string, init: RequestInit = {}, origin: string | null = context.origin) => {
  const headers = new Headers(init.headers);
  if (origin !== null && !headers.has('origin')) headers.set('origin', origin);
  return context.app.request(url, { ...init, headers });
};

export const authPath = (context: AuthContext, path: string, init: RequestInit = {}) =>
  authRequest(context, `${context.origin}/v1/auth${path}`, init);

export const jsonPost = (context: AuthContext, path: string, body: unknown, headers: Record<string, string> = {}) =>
  authPath(context, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

export const firstLink = (mail: CapturedMail): string => {
  const match = mail.text.match(/https?:\/\/\S+/);
  assert.ok(match, 'expected a link in the mail body');
  return match[0]!;
};

export const sessionCookie = (response: Response): string | null => {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => /(?:^|;)\s*(?:__Secure-)?better-auth\.session_token=[^;]/.test(value));
  return cookie ? cookie.split(';')[0]! : null;
};

export const cookieFrom = (response: Response): string => {
  const cookie = sessionCookie(response);
  assert.ok(cookie, 'expected a session cookie');
  return cookie;
};

export const verificationRows = (context: AuthContext) =>
  context.pool.query<{ key: string; value: string }>("SELECT key, value FROM auth_kv WHERE key LIKE 'verification:%'");

export const confirmBody = (confirmUrl: string): string => {
  const body = new URLSearchParams();
  for (const [name, value] of new URL(confirmUrl).searchParams.entries()) body.set(name, value);
  return body.toString();
};

export const postConfirm = (
  context: AuthContext,
  confirmUrl: string,
  options: { origin?: string | null; headers?: Record<string, string>; body?: string } = {},
) =>
  authRequest(
    context,
    `${context.origin}/v1/auth/magic-link/confirm`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) },
      body: options.body ?? confirmBody(confirmUrl),
    },
    options.origin === undefined ? context.origin : options.origin,
  );

export const verifyEmail = async (context: AuthContext, mail: CapturedMail): Promise<void> => {
  const url = new URL(firstLink(mail));
  url.searchParams.set('callbackURL', '/');
  const verified = await authRequest(context, url.toString(), { method: 'GET' });
  assert.equal(verified.status, 302);
  assert.equal(verified.headers.get('location'), '/');
};

/** Signs up, verifies the email and signs in; returns the session cookie. */
export async function signUpVerified(context: AuthContext, email: string, name = 'Test Student'): Promise<string> {
  const signUp = await jsonPost(context, '/sign-up/email', { email, password: PASSWORD, name });
  assert.equal(signUp.status, 200);
  await verifyEmail(context, context.captured.at(-1)!);
  const signIn = await jsonPost(context, '/sign-in/email', { email, password: PASSWORD });
  assert.equal(signIn.status, 200);
  return cookieFrom(signIn);
}
