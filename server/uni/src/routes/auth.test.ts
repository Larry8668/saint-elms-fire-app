import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import type { Account } from '@sef/shared';
import type { UniDeps } from '../deps';
import type { SigningKeys } from '../signing';
import { authRoutes } from './auth';

/**
 * The legacy login route: brute-force attempts from one client are refused with 429
 * while ordinary sign-ins keep working. In these tests every request shares one
 * socket-less ('unknown') client bucket, which is exactly the hammering case.
 */

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keys: SigningKeys = { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };

const STUDENT: Account = {
  id: 'acc-student',
  email: 'student@example.test',
  name: 'Stu Dent',
  role: 'student',
  createdAt: new Date().toISOString(),
};

function deps(authenticate: (email: string, password: string) => Promise<Account | null>): UniDeps {
  return {
    keys,
    accounts: { authenticate },
    audit: { record: async () => undefined },
  } as unknown as UniDeps;
}

function appFor(authenticate: (email: string, password: string) => Promise<Account | null>) {
  const app = new Hono();
  app.route('/v1/auth', authRoutes(deps(authenticate)));
  return app;
}

const login = (app: Hono, body: unknown) =>
  app.request('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a legitimate login still issues a token', async () => {
  const app = appFor(async (email, password) => (email === STUDENT.email && password === 'harbor-lantern' ? STUDENT : null));
  const res = await login(app, { email: STUDENT.email, password: 'harbor-lantern' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string; account: Account };
  assert.equal(typeof body.token, 'string');
  assert.equal(body.account.id, STUDENT.id);
});

test('repeated attempts from one client are refused with 429 after ten tries', async () => {
  const app = appFor(async () => null);
  for (let i = 0; i < 10; i += 1) {
    const res = await login(app, { email: STUDENT.email, password: `guess-${i}` });
    assert.equal(res.status, 401, `attempt ${i + 1} is answered normally`);
  }
  const eleventh = await login(app, { email: STUDENT.email, password: 'guess-11' });
  assert.equal(eleventh.status, 429);
  assert.deepEqual(await eleventh.json(), { error: 'rate_limited' });

  // The window counts attempts, not failures: even correct credentials wait it out.
  const app2 = appFor(async () => STUDENT);
  for (let i = 0; i < 10; i += 1) await login(app2, { email: STUDENT.email, password: 'wrong' });
  const blocked = await login(app2, { email: STUDENT.email, password: 'harbor-lantern' });
  assert.equal(blocked.status, 429, 'a burst of attempts gates the client, not the credential');
});
