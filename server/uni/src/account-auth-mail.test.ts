import assert from 'node:assert/strict';
import test from 'node:test';
import { accountAuthOptions, MAIL_DELIVERY_HEADER, withMailDeliveryReport } from './account-auth';
import type { Mailer } from './mail';

const fail = async () => {
  throw new Error('Account email delivery failed');
};
const failingMail: Mailer = { sendVerificationEmail: fail, sendPasswordReset: fail, sendMagicLink: fail };
const okMail: Mailer = { sendVerificationEmail: async () => {}, sendPasswordReset: async () => {}, sendMagicLink: async () => {} };

const options = (mail: Mailer) => accountAuthOptions({ pool: {} as never, mail, publicUrl: 'http://localhost:8787', secret: 'x'.repeat(40) });

// Mirrors better-auth's runInBackgroundOrAwait: it awaits the callback and swallows its error.
const swallow = async (promise: PromiseLike<unknown> | void) => {
  try {
    await promise;
  } catch {
    /* logged and dropped by better-auth */
  }
};

const verify = (opts: ReturnType<typeof options>) =>
  opts.emailVerification.sendVerificationEmail({ user: { email: 'a@example.test' }, url: 'http://x' });

test('a swallowed mail failure is still reported on the response', async () => {
  const opts = options(failingMail);
  const handler = withMailDeliveryReport(async () => {
    await swallow(verify(opts));
    return Response.json({ ok: true });
  });
  const response = await handler(new Request('http://localhost/v1/auth/sign-up/email'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(MAIL_DELIVERY_HEADER), 'failed');
  assert.deepEqual(await response.json(), { ok: true });
});

test('magic-link and reset failures are reported too', async () => {
  const opts = options(failingMail);
  const sends = [
    () => opts.plugins[0]!.options.sendMagicLink({ email: 'a@example.test', url: 'http://localhost:8787/v1/auth/magic-link/verify?token=t' } as never),
    () => opts.emailAndPassword.sendResetPassword({ user: { email: 'a@example.test' }, url: 'http://x' }),
  ];
  for (const send of sends) {
    const handler = withMailDeliveryReport(async () => {
      await swallow(send());
      return Response.json({});
    });
    assert.equal((await handler(new Request('http://localhost/'))).headers.get(MAIL_DELIVERY_HEADER), 'failed');
  }
});

test('a successful send adds no header and failures do not leak between concurrent requests', async () => {
  const handler = (opts: ReturnType<typeof options>) =>
    withMailDeliveryReport(async () => {
      await swallow(verify(opts));
      return Response.json({});
    });
  const [failed, fine] = await Promise.all([
    handler(options(failingMail))(new Request('http://localhost/')),
    handler(options(okMail))(new Request('http://localhost/')),
  ]);
  assert.equal(failed.headers.get(MAIL_DELIVERY_HEADER), 'failed');
  assert.equal(fine.headers.get(MAIL_DELIVERY_HEADER), null);
});
