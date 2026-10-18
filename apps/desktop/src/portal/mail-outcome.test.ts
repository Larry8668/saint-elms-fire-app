import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MAIL_SEND_FAILED, PortalError, mailOutcome, registerAccount, requestPasswordReset } from './portal-api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const reply = (headers: Record<string, string>, status = 200) => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status, headers })) as typeof fetch;
};

test('a 200 flagged x-mail-delivery: failed is a mail failure, not a success', async () => {
  reply({ 'x-mail-delivery': 'failed' });
  await assert.rejects(
    () => registerAccount({ name: 'Ada', email: 'a@example.test', password: 'long-enough' }),
    (e: unknown) => e instanceof PortalError && e.code === MAIL_SEND_FAILED && /could not send the email/i.test(e.message),
  );
});

test('mailOutcome reports failed for the reset path too, and sent otherwise', async () => {
  reply({ 'x-mail-delivery': 'failed' });
  assert.equal(await mailOutcome(() => requestPasswordReset('a@example.test')), 'failed');
  reply({});
  assert.equal(await mailOutcome(() => requestPasswordReset('a@example.test')), 'sent');
});

test('mailOutcome rethrows other errors', async () => {
  reply({}, 429);
  await assert.rejects(() => mailOutcome(() => requestPasswordReset('a@example.test')), PortalError);
});
