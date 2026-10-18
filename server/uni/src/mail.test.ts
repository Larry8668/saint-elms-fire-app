import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transporter } from 'nodemailer';
import { createMailer, parseMailConfig, resendTransport } from './mail';
import { log } from './logger';

const configFixture = { smtpUrl: 'smtp://127.0.0.1:1025', from: 'Saint Elms Test <test@saintelms.test>' };

interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
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
  const urls = [
    'https://uni.example/v1/auth/magic-link/confirm?token=abc',
    'https://uni.example/verify-email?token=def',
    'https://uni.example/reset-password/ghi',
  ];
  sent.forEach((mail, index) => {
    assert.equal(mail.html.split(`href="${urls[index]}"`).length - 1, 1, 'link appears once as an href');
    assert.ok(mail.html.includes('Saint Elms University'));
    assert.ok(mail.html.includes('If you did not request this, you can ignore this message.'));
    assert.ok(!/<script|<img|<link|@import/i.test(mail.html));
  });
  assert.match(sent[0]!.html, /expires in 15 minutes and can be used once/);
  for (const mail of sent) {
    assert.equal(mail.to, 'student@example.test');
    assert.equal(mail.from, configFixture.from);
  }
});

test('the HTML escapes URLs containing ampersands and quotes', async () => {
  const { sent, transport } = capturingTransport();
  const mailer = createMailer(configFixture, transport);
  await mailer.sendPasswordReset('student@example.test', 'https://uni.example/reset?a=1&b="x"<y>');
  const mail = sent[0]!;
  assert.ok(mail.html.includes('href="https://uni.example/reset?a=1&amp;b=&quot;x&quot;&lt;y&gt;"'));
  assert.ok(!mail.html.includes('b="x"'));
  assert.ok(mail.text.includes('https://uni.example/reset?a=1&b="x"<y>'));
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

test('MAIL_RESEND_API_KEY selects the Resend HTTPS transport, with the sandbox sender by default', async () => {
  assert.throws(() => parseMailConfig({ MAIL_RESEND_API_KEY: 'not-a-key' }), /MAIL_RESEND_API_KEY/);
  const config = parseMailConfig({ NODE_ENV: 'production', MAIL_RESEND_API_KEY: 're_abcdefghijklmnop' });
  assert.equal(config.resendApiKey, 're_abcdefghijklmnop');
  assert.equal(config.from, 'Saint Elms University <onboarding@resend.dev>');
  assert.equal(parseMailConfig({ MAIL_RESEND_API_KEY: 're_abcdefghijklmnop', MAIL_FROM: 'Uni <hello@uni.test>' }).from, 'Uni <hello@uni.test>');

  const calls: Array<{ url: string; auth: string | undefined; body: Record<string, string> }> = [];
  let status = 200;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).authorization, body: JSON.parse(String(init?.body)) as Record<string, string> });
    return new Response(JSON.stringify({ id: 'em_1' }), { status });
  }) as typeof fetch;
  const mailer = createMailer(config, undefined, fetchFn);
  await mailer.sendMagicLink('student@example.test', 'https://uni.example/magic?token=t1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
  assert.equal(calls[0]!.auth, 'Bearer re_abcdefghijklmnop');
  assert.equal(calls[0]!.body.from, config.from);
  assert.equal(calls[0]!.body.to, 'student@example.test');
  assert.match(calls[0]!.body.text, /magic\?token=t1/);
  assert.ok(calls[0]!.body.html!.includes('href="https://uni.example/magic?token=t1"'));

  status = 403;
  await assert.rejects(() => mailer.sendPasswordReset('student@example.test', 'https://uni.example/reset'), /Account email delivery failed/);
  assert.equal(typeof resendTransport('re_x').sendMail, 'function');
});
