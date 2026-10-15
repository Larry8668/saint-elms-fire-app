import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { log } from './logger';

export interface MailConfig {
  smtpUrl: string;
  from: string;
}

/**
 * Mail configuration is validated here rather than in `config.ts` so the SMTP URL (which may
 * carry credentials) stays out of the general config object. Production refuses to run without
 * real SMTP; development falls back to a loopback-only Mailpit instance
 * (`docker compose --profile mail up -d mailpit`).
 */
export function parseMailConfig(environment: NodeJS.ProcessEnv = process.env): MailConfig {
  const smtpUrl = environment.MAIL_SMTP_URL?.trim();
  const from = environment.MAIL_FROM?.trim();
  if (from && /[\r\n]/.test(from)) {
    throw new Error('MAIL_FROM must not contain line breaks');
  }
  if (smtpUrl && /[\r\n]/.test(smtpUrl)) {
    throw new Error('MAIL_SMTP_URL must not contain line breaks');
  }
  if (!smtpUrl) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('MAIL_SMTP_URL is required in production; refusing to boot without real mail delivery');
    }
    return { smtpUrl: 'smtp://127.0.0.1:1025', from: from || 'Saint Elms University <no-reply@saintelms.local>' };
  }
  let parsed: URL;
  try {
    parsed = new URL(smtpUrl);
  } catch {
    throw new Error('MAIL_SMTP_URL is not a valid URL');
  }
  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
    throw new Error('MAIL_SMTP_URL must use smtp:// or smtps://');
  }
  if (!parsed.hostname) {
    throw new Error('MAIL_SMTP_URL must include a hostname');
  }
  return { smtpUrl, from: from || `Saint Elms University <no-reply@${parsed.hostname}>` };
}

export interface Mailer {
  sendVerificationEmail(to: string, url: string): Promise<void>;
  sendPasswordReset(to: string, url: string): Promise<void>;
  sendMagicLink(to: string, url: string): Promise<void>;
}

const templates = {
  verification: () => ({
    subject: 'Verify your Saint Elms University email',
    body: (url: string) =>
      `Confirm this address to finish creating your Saint Elms University account:\n\n${url}\n\nIf you did not request this, you can ignore this message.`,
  }),
  'password-reset': () => ({
    subject: 'Reset your Saint Elms University password',
    body: (url: string) =>
      `Use this link to choose a new password:\n\n${url}\n\nIf you did not request this, you can ignore this message.`,
  }),
  'magic-link': () => ({
    subject: 'Your Saint Elms University sign-in link',
    body: (url: string) =>
      `This link signs you in to your Saint Elms University account. It expires in 15 minutes and can be used once:\n\n${url}\n\nIf you did not request this, you can ignore this message.`,
  }),
} as const;

type TemplateName = keyof typeof templates;

/**
 * All sends fail loudly: there is no code path that reports mail as sent without SMTP accepting
 * it. Recipient addresses and links are never logged.
 */
export function createMailer(config: MailConfig, transport?: Transporter): Mailer {
  const transporter =
    transport ??
    nodemailer.createTransport({
      url: config.smtpUrl,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });

  const send = async (template: TemplateName, to: string, url: string) => {
    const { subject, body } = templates[template]();
    try {
      const result = await transporter.sendMail({ from: config.from, to, subject, text: body(url) });
      if (!Array.isArray(result.accepted) || result.accepted.length === 0) throw new Error('mail_rejected');
      log.info('mail_sent', { template });
    } catch {
      log.error('mail_send_failed', { template });
      throw new Error('Account email delivery failed');
    }
  };

  return {
    sendVerificationEmail: (to, url) => send('verification', to, url),
    sendPasswordReset: (to, url) => send('password-reset', to, url),
    sendMagicLink: (to, url) => send('magic-link', to, url),
  };
}
