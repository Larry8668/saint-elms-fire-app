import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Pool } from 'pg';
import test from 'node:test';
import type { Transporter } from 'nodemailer';
import { createAccountAuth } from './account-auth';
import { closeDatabasePool, createDatabasePool, parseDatabaseConfig } from './db';
import { migrateDatabase } from './db/migrate';
import { createMailer } from './mail';
import { magicLinkConfirm } from './routes/account';

// These account-authentication integration tests only run inside the disposable Compose test
// workflow (`pnpm --filter @sef/uni-server db:test:integration`), against a throwaway database.

const testDatabaseUrl = process.env.UNI_DB_TEST_RUNNER === 'compose-ephemeral'
  ? process.env.UNI_TEST_DATABASE_URL
  : undefined;
const testOptions = { skip: !testDatabaseUrl };

const ORIGIN = 'http://localhost:4200';
const PASSWORD = 'correct-horse-battery-staple';

interface CapturedMail {
  to: string;
  subject: string;
  text: string;
}

interface AuthContext {
  pool: ReturnType<typeof createDatabasePool>;
  captured: CapturedMail[];
  app: Hono;
}

function safeTestDatabaseUrl(): string {
  assert.ok(testDatabaseUrl, 'UNI_TEST_DATABASE_URL is required');
  const url = new URL(testDatabaseUrl);
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/sef_uni_test');
  assert.ok(Number(url.port) >= 1024);
  return testDatabaseUrl;
}

async function withAuthSchema(run: (context: AuthContext) => Promise<void>): Promise<void> {
  const url = safeTestDatabaseUrl();
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  const schema = `pr04_${randomUUID().replaceAll('-', '')}`;
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
      sendMail: async (options: CapturedMail) => {
        captured.push(options);
        return { accepted: [options.to] };
      },
    } as unknown as Transporter;
    const mail = createMailer({ smtpUrl: 'smtp://127.0.0.1:1025', from: 'Sef Test <test@saintelms.test>' }, transport);
    const accountAuth = createAccountAuth({
      pool,
      mail,
      publicUrl: ORIGIN,
      secret: 'integration-test-secret-0123456789-0123456789',
    });
    // Mirror the server's mounting: the confirmation hop lives ahead of the better-auth catch-all.
    const app = new Hono();
    app.get('/v1/auth/magic-link/confirm', magicLinkConfirm);
    app.all('/v1/auth/*', (c) => accountAuth.handler(c.req.raw));
    await run({ pool, captured, app });
  } finally {
    await closeDatabasePool(pool);
  }
}

const authRequest = (context: AuthContext, url: string, init: RequestInit = {}) =>
  context.app.request(url, {
    ...init,
    headers: { origin: ORIGIN, ...(init.headers ?? {}) },
  });

const authPath = (context: AuthContext, path: string, init: RequestInit = {}) =>
  authRequest(context, `${ORIGIN}/v1/auth${path}`, init);

const jsonPost = (context: AuthContext, path: string, body: unknown, headers: Record<string, string> = {}) =>
  authPath(context, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const firstLink = (mail: CapturedMail): string => {
  const match = mail.text.match(/https?:\/\/\S+/);
  assert.ok(match, 'expected a link in the mail body');
  return match[0]!;
};

const cookieFrom = (response: Response): string => {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a session cookie');
  return header.split(';')[0]!;
};

async function signUpVerified(context: AuthContext, email: string): Promise<string> {
  const signUp = await jsonPost(context, '/sign-up/email', { email, password: PASSWORD, name: 'Test Student' });
  assert.equal(signUp.status, 200);
  const verified = await authRequest(context, firstLink(context.captured.at(-1)!), { method: 'GET' });
  assert.equal(verified.status, 302);
  const signIn = await jsonPost(context, '/sign-in/email', { email, password: PASSWORD });
  assert.equal(signIn.status, 200);
  return cookieFrom(signIn);
}

test('registration requires email verification and sign-in stays blocked until then', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    const signUp = await jsonPost(context, '/sign-up/email', { email: 'ada@example.test', password: PASSWORD, name: 'Ada Lovelace' });
    assert.equal(signUp.status, 200);
    assert.equal(captured.length, 1);
    assert.match(captured[0]!.subject, /Verify/);

    const blocked = await jsonPost(context, '/sign-in/email', { email: 'ada@example.test', password: PASSWORD });
    assert.equal(blocked.status, 403);

    const verified = await authRequest(context, firstLink(captured[0]!), { method: 'GET' });
    assert.equal(verified.status, 302);

    const signIn = await jsonPost(context, '/sign-in/email', { email: 'ada@example.test', password: PASSWORD });
    assert.equal(signIn.status, 200);
    assert.ok(cookieFrom(signIn).includes('session_token'));

    const row = await pool.query<{ emailVerified: boolean }>('SELECT "emailVerified" FROM "user" WHERE email = $1', ['ada@example.test']);
    assert.equal(row.rows[0]?.emailVerified, true);
  });
});

test('duplicate registration is answered generically, creates nothing, and sends no second mail', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;

    const first = await jsonPost(context, '/sign-up/email', { email: 'grace@example.test', password: PASSWORD, name: 'Grace' });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { token: unknown; user?: { email?: string } };
    assert.equal(firstBody.token, null);

    const duplicate = await jsonPost(context, '/sign-up/email', { email: 'grace@example.test', password: PASSWORD, name: 'Someone Else' });
    // The pinned release answers a generic success-shaped response while verification is required;
    // it must not return a usable session or a distinguishable error.
    assert.equal(duplicate.status, 200);
    const duplicateBody = (await duplicate.json()) as { token: unknown; user?: { email?: string } };
    assert.equal(duplicateBody.token, null);
    assert.ok(!('error' in duplicateBody));
    assert.equal(captured.length, 1, 'no second email for an existing account');

    const count = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM "user" WHERE email = $1', ['grace@example.test']);
    assert.equal(count.rows[0]!.n, '1');
  });
});

test('magic links are scanner-safe, atomically single-use, and expire', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    await signUpVerified(context, 'marie@example.test');

    await jsonPost(context, '/sign-in/magic-link', { email: 'marie@example.test' });
    const confirmUrl = firstLink(captured.at(-1)!);
    assert.ok(confirmUrl.includes('/v1/auth/magic-link/confirm'));

    // A mail scanner fetching the confirmation page must not consume the token.
    const scan = await authRequest(context, confirmUrl, { method: 'GET' });
    assert.equal(scan.status, 200);
    const tokensAfterScan = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM auth_kv WHERE key LIKE 'verification:%'");
    assert.equal(tokensAfterScan.rows[0]!.n, '1');

    const html = await scan.text();
    const href = html.match(/href="([^"]*magic-link\/verify[^"]*)"/)?.[1];
    assert.ok(href, 'expected a verify link in the confirmation page');
    const verifyUrl = href.replaceAll('&amp;', '&');

    const verified = await authRequest(context, verifyUrl, { method: 'GET' });
    assert.equal(verified.status, 302);
    assert.ok(cookieFrom(verified).includes('session_token'));

    // The same link cannot be consumed twice.
    const replay = await authRequest(context, verifyUrl, { method: 'GET' });
    assert.ok(!replay.headers.get('set-cookie'));
    const remaining = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM auth_kv WHERE key LIKE 'verification:%'");
    assert.equal(remaining.rows[0]!.n, '0');
  });
});

test('expired magic links are refused (and deleted so they cannot be replayed later)', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    await signUpVerified(context, 'niels@example.test');

    await jsonPost(context, '/sign-in/magic-link', { email: 'niels@example.test' });
    const verifyUrl = firstLink(captured.at(-1)!).replace('/magic-link/confirm', '/magic-link/verify');

    await pool.query("UPDATE auth_kv SET expires_at = now() - interval '1 hour' WHERE key LIKE 'verification:%'");

    const expired = await authRequest(context, verifyUrl, { method: 'GET' });
    assert.ok(!expired.headers.get('set-cookie'));
    const remaining = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM auth_kv WHERE key LIKE 'verification:%'");
    assert.equal(remaining.rows[0]!.n, '0');
  });
});

test('password recovery is generic, single-use, and replaces the credential', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { captured } = context;
    await signUpVerified(context, 'emmy@example.test');

    const unknown = await jsonPost(context, '/request-password-reset', { email: 'nobody@example.test' });
    assert.equal(unknown.status, 200);
    assert.equal(captured.length, 1); // no mail for a non-existent account

    await jsonPost(context, '/request-password-reset', { email: 'emmy@example.test' });
    const resetUrl = firstLink(captured.at(-1)!);
    const token = resetUrl.split('/reset-password/')[1]!.split('?')[0]!;

    const newPassword = 'newer-correct-horse-battery-9';
    const reset = await jsonPost(context, '/reset-password', { newPassword, token });
    assert.equal(reset.status, 200);

    const replay = await jsonPost(context, '/reset-password', { newPassword: 'third-password-attempt', token });
    assert.notEqual(replay.status, 200);

    const oldPassword = await jsonPost(context, '/sign-in/email', { email: 'emmy@example.test', password: PASSWORD });
    assert.equal(oldPassword.status, 401);
    const newLogin = await jsonPost(context, '/sign-in/email', { email: 'emmy@example.test', password: newPassword });
    assert.equal(newLogin.status, 200);
  });
});

test('rate limiting is enforced and database-backed', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool } = context;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await jsonPost(context, '/sign-in/email', { email: 'brute@example.test', password: `wrong-password-${attempt}` });
      statuses.push(res.status);
    }
    assert.equal(statuses[0], 401);
    assert.equal(statuses.at(-1), 429);

    const counters = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM auth_kv WHERE key NOT LIKE 'verification:%'");
    assert.ok(Number(counters.rows[0]!.n) >= 1, 'expected rate-limit counters in auth_kv');
  });
});

test('sessions can be revoked', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const cookie = await signUpVerified(context, 'lise@example.test');

    const before = await authPath(context, '/get-session', { headers: { cookie } });
    assert.equal(before.status, 200);
    assert.ok((await before.json()) as object);

    const revoked = await jsonPost(context, '/revoke-sessions', {}, { cookie });
    assert.equal(revoked.status, 200);

    const after = await authPath(context, '/get-session', { headers: { cookie } });
    assert.equal(after.status, 200);
    assert.equal(await after.json(), null);
  });
});

test('device authorization and staff MFA primitives are mounted', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const device = await jsonPost(context, '/device/code', { client_id: 'sef-integration-test' });
    assert.equal(device.status, 200);
    const body = (await device.json()) as { device_code?: string; user_code?: string };
    assert.ok(body.device_code && body.user_code);

    const mfa = await jsonPost(context, '/two-factor/get-totp-uri', { password: 'not-a-session' });
    assert.equal(mfa.status, 401);
  });
});

test('untrusted origins are rejected', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const evil = await authRequest(context, `${ORIGIN}/v1/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'victim@example.test', password: PASSWORD, name: 'V' }),
    });
    assert.equal(evil.status, 403);
  });
});

test('account sessions carry no university privilege', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool } = context;
    await signUpVerified(context, 'plain@example.test');
    // The session exists in the database, but it is not a staff membership or an enrolment.
    const memberships = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM staff_memberships');
    const enrolments = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM enrolments');
    assert.equal(memberships.rows[0]!.n, '0');
    assert.equal(enrolments.rows[0]!.n, '0');
  });
});
