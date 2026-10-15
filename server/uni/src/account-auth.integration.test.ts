import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Pool } from 'pg';
import test from 'node:test';
import type { Transporter } from 'nodemailer';
import { createAccountAuth, type AccountAuth } from './account-auth';
import { closeDatabasePool, createDatabasePool, parseDatabaseConfig } from './db';
import { migrateDatabase } from './db/migrate';
import { createMailer } from './mail';

// These account-authentication integration tests only run inside the disposable Compose test
// workflow (`pnpm --filter @sef/uni-server db:test:integration`), against a throwaway database.

const testDatabaseUrl = process.env.UNI_DB_TEST_RUNNER === 'compose-ephemeral'
  ? process.env.UNI_TEST_DATABASE_URL
  : undefined;
const testOptions = { skip: !testDatabaseUrl };

const ORIGIN = 'http://localhost:4200';
const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'integration-test-secret-0123456789-0123456789';

interface CapturedMail {
  to: string;
  subject: string;
  text: string;
}

interface AuthContext {
  pool: ReturnType<typeof createDatabasePool>;
  captured: CapturedMail[];
  app: Hono;
  auth: AccountAuth;
  makeAuth: () => AccountAuth;
  origin: string;
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

async function withAuthSchema(run: (context: AuthContext) => Promise<void>, publicOrigin = ORIGIN): Promise<void> {
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
    const makeAuth = () => createAccountAuth({ pool, mail, publicUrl: publicOrigin, secret: SECRET });
    const accountAuth = makeAuth();
    // Mirror the server's mounting: the wrapper lives inside the account handler itself.
    const app = new Hono();
    app.all('/v1/auth/*', (c) => accountAuth.handler(c.req.raw));
    await run({ pool, captured, app, auth: accountAuth, makeAuth, origin: publicOrigin });
  } finally {
    await closeDatabasePool(pool);
  }
}

const authRequest = (context: AuthContext, url: string, init: RequestInit = {}, origin: string | null = context.origin) => {
  const headers = new Headers(init.headers);
  if (origin !== null && !headers.has('origin')) headers.set('origin', origin);
  return context.app.request(url, { ...init, headers });
};

const authPath = (context: AuthContext, path: string, init: RequestInit = {}) =>
  authRequest(context, `${context.origin}/v1/auth${path}`, init);

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

const sessionCookie = (response: Response): string | null => {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => /(?:^|;)\s*(?:__Secure-)?better-auth\.session_token=[^;]/.test(value));
  return cookie ? cookie.split(';')[0]! : null;
};

const cookieFrom = (response: Response): string => {
  const cookie = sessionCookie(response);
  assert.ok(cookie, 'expected a session cookie');
  return cookie;
};

const verificationRows = (context: AuthContext) =>
  context.pool.query<{ key: string; value: string }>("SELECT key, value FROM auth_kv WHERE key LIKE 'verification:%'");

const confirmBody = (confirmUrl: string): string => {
  const body = new URLSearchParams();
  for (const [name, value] of new URL(confirmUrl).searchParams.entries()) body.set(name, value);
  return body.toString();
};

const postConfirm = (context: AuthContext, confirmUrl: string, options: { origin?: string | null; headers?: Record<string, string>; body?: string } = {}) =>
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

const verifyEmail = async (context: AuthContext, mail: CapturedMail): Promise<void> => {
  const url = new URL(firstLink(mail));
  url.searchParams.set('callbackURL', '/');
  const verified = await authRequest(context, url.toString(), { method: 'GET' });
  assert.equal(verified.status, 302);
  assert.equal(verified.headers.get('location'), '/');
};

async function signUpVerified(context: AuthContext, email: string, name = 'Test Student'): Promise<string> {
  const signUp = await jsonPost(context, '/sign-up/email', { email, password: PASSWORD, name });
  assert.equal(signUp.status, 200);
  await verifyEmail(context, context.captured.at(-1)!);
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

    await verifyEmail(context, captured[0]!);

    const signIn = await jsonPost(context, '/sign-in/email', { email: 'ada@example.test', password: PASSWORD });
    assert.equal(signIn.status, 200);
    assert.ok(cookieFrom(signIn).includes('session_token'));
    const issued = signIn.headers.getSetCookie().find((value) => value.includes('session_token='))!;
    assert.match(issued, /HttpOnly/i);
    assert.match(issued, /SameSite=Lax/i);

    const row = await pool.query<{ emailVerified: boolean }>('SELECT "emailVerified" FROM "user" WHERE email = $1', ['ada@example.test']);
    assert.equal(row.rows[0]?.emailVerified, true);
  });
});

test('duplicate registration is answered generically, creates nothing, and sends no second mail', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;

    const first = await jsonPost(context, '/sign-up/email', { email: 'grace@example.test', password: PASSWORD, name: 'Grace' });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { token: unknown; user?: { id?: string } };
    assert.equal(firstBody.token, null);

    const duplicate = await jsonPost(context, '/sign-up/email', { email: 'grace@example.test', password: PASSWORD, name: 'Someone Else' });
    // The pinned release answers a generic success-shaped response while verification is required;
    // it must not return a usable session or a distinguishable error.
    assert.equal(duplicate.status, first.status);
    const duplicateBody = (await duplicate.json()) as { token: unknown; user?: { id?: string } };
    assert.deepEqual(Object.keys(duplicateBody).sort(), Object.keys(firstBody).sort());
    assert.ok(duplicateBody.user && firstBody.user);
    assert.deepEqual(Object.keys(duplicateBody.user).sort(), Object.keys(firstBody.user).sort());
    assert.equal(duplicateBody.token, null);
    assert.ok(!('error' in duplicateBody));
    assert.notEqual(duplicateBody.user.id, firstBody.user.id, 'the duplicate carries a synthetic identity, not the real row');
    assert.equal(captured.length, 1, 'no second email for an existing account');

    const rows = await pool.query<{ n: string; name: string }>('SELECT count(*)::text AS n, min(name) AS name FROM "user" WHERE email = $1', ['grace@example.test']);
    assert.equal(rows.rows[0]!.n, '1');
    assert.equal(rows.rows[0]!.name, 'Grace', 'the original identity is unchanged');
  });
});

test('magic link GETs and scanner requests never consume the token', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    await signUpVerified(context, 'marie@example.test');

    await jsonPost(context, '/sign-in/magic-link', { email: 'marie@example.test' });
    const confirmUrl = firstLink(captured.at(-1)!);
    assert.ok(confirmUrl.includes('/v1/auth/magic-link/confirm'));
    assert.equal((await verificationRows(context)).rows.length, 1);

    const scan = await authRequest(context, confirmUrl, { method: 'GET' });
    assert.equal(scan.status, 200);
    assert.ok(!sessionCookie(scan));

    const head = await authRequest(context, confirmUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const verifyUrl = confirmUrl.replace('/magic-link/confirm', '/magic-link/verify');
    const trailingSlash = new URL(verifyUrl);
    trailingSlash.pathname += '/';
    const aliases = [
      verifyUrl,
      trailingSlash.toString(),
      verifyUrl.replace('/magic-link/', '//magic-link/'),
      verifyUrl.replace('/verify', '/%76erify'),
    ];
    for (const alias of aliases) {
      const response = await authRequest(context, alias, { method: 'GET' });
      assert.equal(response.status, 303, alias);
      assert.ok(!sessionCookie(response));
      const location = new URL(response.headers.get('location') ?? '');
      assert.equal(location.origin, ORIGIN);
      assert.equal(location.pathname, '/v1/auth/magic-link/confirm');
    }
    const verifyHead = await authRequest(context, verifyUrl, { method: 'HEAD' });
    assert.equal(verifyHead.status, 303);

    assert.equal((await verificationRows(context)).rows.length, 1, 'no GET consumed the token');
  });
});

test('the confirmation page posts the token back over a fixed same-origin form', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { captured } = context;
    await jsonPost(context, '/sign-in/magic-link', { email: 'page@example.test' });
    const confirmUrl = firstLink(captured.at(-1)!);

    const response = await authRequest(context, confirmUrl, { method: 'GET' });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('method="post"'));
    assert.ok(html.includes('action="/v1/auth/magic-link/confirm"'));
    assert.ok(html.includes('<button type="submit">'));
    assert.ok(!html.includes('magic-link/verify'), 'no consuming link on the page');
    assert.ok(!html.includes('<script'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

    const hostile = await authRequest(context, confirmUrl.replace(context.origin, 'https://evil.example'), { method: 'GET' }, null);
    const hostileHtml = await hostile.text();
    assert.ok(hostileHtml.includes('action="/v1/auth/magic-link/confirm"'));
    assert.ok(!hostileHtml.includes('evil.example'));
  });
});

test('only a same-origin POST consumes the magic token, exactly once', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    await signUpVerified(context, 'marie@example.test');
    await jsonPost(context, '/sign-in/magic-link', { email: 'marie@example.test' });
    const confirmUrl = firstLink(captured.at(-1)!);

    const hostileOrigin = await postConfirm(context, confirmUrl, { origin: 'https://evil.example' });
    assert.equal(hostileOrigin.status, 403);
    const missingOrigin = await postConfirm(context, confirmUrl, { origin: null });
    assert.equal(missingOrigin.status, 403);
    const wrongType = await postConfirm(context, confirmUrl, { headers: { 'content-type': 'application/json' } });
    assert.equal(wrongType.status, 415);
    const oversized = await postConfirm(context, confirmUrl, { body: `token=${'x'.repeat(17 * 1024)}` });
    assert.equal(oversized.status, 413);
    const duplicateField = await postConfirm(context, confirmUrl, { body: 'token=a&token=b' });
    assert.equal(duplicateField.status, 400);
    assert.equal((await verificationRows(context)).rows.length, 1, 'rejected submissions never consume the token');

    const secondInstance = context.makeAuth();
    const directPost = () =>
      new Request(`${context.origin}/v1/auth/magic-link/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: context.origin },
        body: confirmBody(confirmUrl),
      });
    const [first, second] = await Promise.all([postConfirm(context, confirmUrl), secondInstance.handler(directPost())]);
    const minted = [first, second].filter((response) => sessionCookie(response) !== null);
    assert.equal(minted.length, 1, 'concurrent confirmations race for a single session across instances');
    assert.equal(minted[0]!.status, 302);

    const liveSession = await authPath(context, '/get-session', { headers: { cookie: cookieFrom(minted[0]!) } });
    const liveBody = (await liveSession.json()) as { user?: { email?: string } } | null;
    assert.equal(liveBody?.user?.email, 'marie@example.test');

    const replay = await postConfirm(context, confirmUrl);
    assert.ok(!sessionCookie(replay));
    assert.equal((await verificationRows(context)).rows.length, 0);
  });
});

test('hostile callback URLs cannot redirect externally or mint a session', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { captured } = context;
    await signUpVerified(context, 'hypatia@example.test');
    await jsonPost(context, '/sign-in/magic-link', { email: 'hypatia@example.test' });
    const confirmUrl = firstLink(captured.at(-1)!);

    for (const callbackURL of ['//evil.example', 'https://evil.example']) {
      const body = new URLSearchParams();
      body.set('token', new URL(confirmUrl).searchParams.get('token')!);
      body.set('callbackURL', callbackURL);
      const response = await postConfirm(context, confirmUrl, { body: body.toString() });
      assert.equal(response.status, 403, callbackURL);
      assert.ok(!sessionCookie(response));
      assert.ok(!response.headers.get('location')?.includes('evil.example'));
    }

    const clean = await postConfirm(context, confirmUrl);
    assert.equal(clean.status, 302, 'the token survives the rejected attempts');
    assert.ok(sessionCookie(clean));
  });
});

test('expired magic links are refused (and deleted so they cannot be replayed later)', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured, auth } = context;
    await signUpVerified(context, 'niels@example.test');

    await jsonPost(context, '/sign-in/magic-link', { email: 'niels@example.test' });
    const confirmUrl = firstLink(captured.at(-1)!);

    await pool.query("UPDATE auth_kv SET expires_at = now() - interval '1 hour' WHERE key LIKE 'verification:%'");

    const expired = await postConfirm(context, confirmUrl);
    assert.ok(!sessionCookie(expired));
    assert.match(expired.headers.get('location') ?? '', /INVALID_TOKEN/);
    assert.equal((await verificationRows(context)).rows.length, 0, 'the expired row is removed, not replayable');

    await pool.query("INSERT INTO auth_kv (key, value, expires_at) VALUES ('expired-kv-row', 'v', now() - interval '1 minute')");
    assert.equal(await auth.storage.get('expired-kv-row'), null);
    const gone = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM auth_kv WHERE key = 'expired-kv-row'");
    assert.equal(gone.rows[0]!.n, '0', 'an expired get removes the row');
  });
});

test('magic tokens are stored hashed in auth_kv with a 15 minute TTL', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    await jsonPost(context, '/sign-in/magic-link', { email: 'stored@example.test', name: 'Stored' });
    const token = new URL(firstLink(captured.at(-1)!)).searchParams.get('token')!;

    const rows = await pool.query<{ key: string; value: string; ttl: number }>(
      "SELECT key, value, EXTRACT(EPOCH FROM expires_at - now())::int AS ttl FROM auth_kv WHERE key LIKE 'verification:%'",
    );
    const verification = rows.rows;
    assert.equal(verification.length, 1);
    for (const row of verification) {
      assert.ok(!row.key.includes(token) && !row.value.includes(token), 'the raw bearer is never stored');
    }
    assert.ok(verification[0]!.ttl > 600 && verification[0]!.ttl <= 900, `ttl was ${verification[0]!.ttl}`);
  });
});

test('password recovery is generic, single-use, replaces the credential, and revokes sessions', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { captured } = context;
    const cookie = await signUpVerified(context, 'emmy@example.test');

    const unknown = await jsonPost(context, '/request-password-reset', { email: 'nobody@example.test' });
    const existing = await jsonPost(context, '/request-password-reset', { email: 'emmy@example.test' });
    assert.equal(unknown.status, existing.status);
    assert.deepEqual(Object.keys((await unknown.json()) as object).sort(), Object.keys((await existing.json()) as object).sort());
    const resetMail = captured.findLast((mail) => mail.text.includes('/reset-password/'))!;
    const resetUrl = firstLink(resetMail);
    const token = resetUrl.split('/reset-password/')[1]!.split('?')[0]!;

    const newPassword = 'newer-correct-horse-battery-9';
    const reset = await jsonPost(context, '/reset-password', { newPassword, token });
    assert.equal(reset.status, 200);

    const replay = await jsonPost(context, '/reset-password', { newPassword: 'third-password-attempt', token });
    assert.notEqual(replay.status, 200);

    const staleSession = await authPath(context, '/get-session', { headers: { cookie } });
    assert.equal(await staleSession.json(), null, 'password reset revokes previously issued sessions');

    const oldPassword = await jsonPost(context, '/sign-in/email', { email: 'emmy@example.test', password: PASSWORD });
    assert.equal(oldPassword.status, 401);
    const newLogin = await jsonPost(context, '/sign-in/email', { email: 'emmy@example.test', password: newPassword });
    assert.equal(newLogin.status, 200);
  });
});

test('rate limiting is enforced in the database across auth instances', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, makeAuth } = context;
    const second = makeAuth();
    const attempt = (handler: (request: Request) => Promise<Response>, index: number) =>
      handler(
        new Request(`${context.origin}/v1/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: context.origin },
          body: JSON.stringify({ email: 'brute@example.test', password: `wrong-password-${index}` }),
        }),
      );

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => attempt(index % 2 === 0 ? context.auth.handler : second.handler, index)),
    );
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 401).length, 10, `statuses: ${statuses}`);
    assert.equal(statuses.filter((status) => status === 429).length, 2, `statuses: ${statuses}`);

    const counters = await pool.query<{ value: string }>("SELECT value FROM auth_kv WHERE key LIKE '%/sign-in/email'");
    assert.equal(counters.rows.length, 1);
    assert.equal(counters.rows[0]!.value, '12', 'every attempt incremented the shared counter exactly once');
  });
});

test('sessions can be revoked and sign-out invalidates the cookie', testOptions, async () => {
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

    const again = await jsonPost(context, '/sign-in/email', { email: 'lise@example.test', password: PASSWORD });
    assert.equal(again.status, 200);
    const cookie2 = cookieFrom(again);
    const signOut = await jsonPost(context, '/sign-out', {}, { cookie: cookie2 });
    assert.equal(signOut.status, 200);
    const afterSignOut = await authPath(context, '/get-session', { headers: { cookie: cookie2 } });
    assert.equal(await afterSignOut.json(), null);
  });
});

test('passwordless magic-link sign-in creates a verified account with a live session', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    const request = await jsonPost(context, '/sign-in/magic-link', { email: 'fresh@example.test', name: 'Fresh User' });
    assert.equal(request.status, 200);

    const confirm = await postConfirm(context, firstLink(captured.at(-1)!));
    assert.equal(confirm.status, 302);
    const cookie = cookieFrom(confirm);

    const rows = await pool.query<{ emailVerified: boolean; name: string }>(
      'SELECT "emailVerified", name FROM "user" WHERE email = $1',
      ['fresh@example.test'],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.emailVerified, true);
    assert.equal(rows.rows[0]!.name, 'Fresh User');

    const session = await authPath(context, '/get-session', { headers: { cookie } });
    const body = (await session.json()) as { user?: { email?: string } } | null;
    assert.equal(body?.user?.email, 'fresh@example.test');
  });
});

test('magic verification strips credentials a pre-proof unverified account accrued', testOptions, async () => {
  await withAuthSchema(async (context) => {
    const { pool, captured } = context;
    const attackerPassword = 'attacker-chosen-password-9';
    const signUp = await jsonPost(context, '/sign-up/email', { email: 'victim@example.test', password: attackerPassword, name: 'Victim' });
    assert.equal(signUp.status, 200);

    await jsonPost(context, '/sign-in/magic-link', { email: 'victim@example.test' });
    const confirm = await postConfirm(context, firstLink(captured.at(-1)!));
    assert.equal(confirm.status, 302);
    assert.ok(sessionCookie(confirm));

    const rows = await pool.query<{ emailVerified: boolean }>('SELECT "emailVerified" FROM "user" WHERE email = $1', ['victim@example.test']);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.emailVerified, true);

    const attacker = await jsonPost(context, '/sign-in/email', { email: 'victim@example.test', password: attackerPassword });
    assert.equal(attacker.status, 401);
    assert.ok(!sessionCookie(attacker));
  });
});

test('session cookies carry Secure, HttpOnly and SameSite=Lax under an https public origin', testOptions, async () => {
  await withAuthSchema(async (context) => {
    await jsonPost(context, '/sign-in/magic-link', { email: 'secure@example.test', name: 'Secure' });
    const confirmUrl = firstLink(context.captured.at(-1)!);
    assert.ok(confirmUrl.startsWith('https://uni.example.test'));

    const confirm = await postConfirm(context, confirmUrl);
    assert.equal(confirm.status, 302);
    const issued = confirm.headers.getSetCookie().find((value) => value.includes('session_token'));
    assert.ok(issued, 'expected a session cookie');
    assert.match(issued, /^__Secure-/);
    assert.match(issued, /Secure/i);
    assert.match(issued, /HttpOnly/i);
    assert.match(issued, /SameSite=Lax/i);
  }, 'https://uni.example.test');
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
    const evil = await authRequest(
      context,
      `${context.origin}/v1/auth/sign-up/email`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'victim@example.test', password: PASSWORD, name: 'V' }),
      },
      'https://evil.example',
    );
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
