import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transporter } from 'nodemailer';
import { createMailer, parseMailConfig } from './mail';
import { log } from './logger';

const configFixture = { smtpUrl: 'smtp://127.0.0.1:1025', from: 'Saint Elms Test <test@saintelms.test>' };

interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

function capturingTransport() {
  const sent: SentMail[] = [];
  const transport = {
    sendMail: async (options: SentMail) => {
      sent.push(options);
      return { accepted: [options.to] };
    },
  } as unknown as Transporter;
  return { sent, transport };
}

test('mail config refuses production without SMTP and defaults to loopback Mailpit in development', () => {
  assert.throws(() => parseMailConfig({ NODE_ENV: 'production' }), /MAIL_SMTP_URL is required in production/);

  const dev = parseMailConfig({});
  assert.equal(dev.smtpUrl, 'smtp://127.0.0.1:1025');

  assert.throws(() => parseMailConfig({ MAIL_SMTP_URL: 'https://mail.example' }), /smtp:\/\/ or smtps:\/\//);
  assert.throws(() => parseMailConfig({ MAIL_SMTP_URL: 'not a url' }), /not a valid URL/);
  assert.throws(() => parseMailConfig({ MAIL_SMTP_URL: 'smtp://' }), /hostname/);
  assert.throws(() => parseMailConfig({ MAIL_FROM: 'Saint Elms\nBCC: evil@example.test' }), /line breaks/);
  assert.throws(() => parseMailConfig({ MAIL_SMTP_URL: 'smtp://127.0.0.1:1025\nX-Injected: yes' }), /line breaks/);

  const prod = parseMailConfig({ NODE_ENV: 'production', MAIL_SMTP_URL: 'smtps://mail.example:465' });
  assert.equal(prod.from, 'Saint Elms University <no-reply@mail.example>');
});

test('each template renders its own link and subject', async () => {
  const { sent, transport } = capturingTransport();
  const mailer = createMailer(configFixture, transport);

  await mailer.sendMagicLink('student@example.test', 'https://uni.example/v1/auth/magic-link/confirm?token=abc');
  await mailer.sendVerificationEmail('student@example.test', 'https://uni.example/verify-email?token=def');
  await mailer.sendPasswordReset('student@example.test', 'https://uni.example/reset-password/ghi');

  assert.equal(sent.length, 3);
  assert.match(sent[0]!.subject, /sign-in link/);
  assert.match(sent[0]!.text, /expires in 15 minutes and can be used once/);
  assert.match(sent[0]!.text, /magic-link\/confirm\?token=abc/);
  assert.match(sent[1]!.subject, /Verify/);
  assert.match(sent[1]!.text, /verify-email\?token=def/);
  assert.match(sent[2]!.text, /reset-password\/ghi/);
  for (const mail of sent) {
    assert.equal(mail.to, 'student@example.test');
    assert.equal(mail.from, configFixture.from);
  }
});

test('send failures surface a generic error without leaking transport details', async (t) => {
  const logged: unknown[] = [];
  t.mock.method(log, 'error', (event: string, fields?: unknown) => logged.push({ event, fields }));
  const failing = {
    sendMail: async () => {
      throw new Error('smtp unreachable at user:secretpw@smtp.internal token tok_abc123');
    },
  } as unknown as Transporter;
  const mailer = createMailer(configFixture, failing);
  await assert.rejects(
    () => mailer.sendVerificationEmail('recipient@example.test', 'https://uni.example/verify-email?token=tok_abc123'),
    (error: unknown) => {
      assert.equal((error as Error).message, 'Account email delivery failed');
      return true;
    },
  );
  const serialized = JSON.stringify(logged);
  for (const secret of ['secretpw', 'tok_abc123', 'smtp.internal', 'recipient@example.test', 'unreachable']) {
    assert.ok(!serialized.includes(secret), `expected ${secret} to stay out of mail failure logs`);
  }
});

test('a transport that accepts no recipients still fails the send', async () => {
  const rejected = { sendMail: async () => ({ accepted: [], rejected: ['a@b.c'] }) } as unknown as Transporter;
  const mailer = createMailer(configFixture, rejected);
  await assert.rejects(() => mailer.sendVerificationEmail('a@b.c', 'https://uni.example/verify-email?token=x'), /Account email delivery failed/);
});
