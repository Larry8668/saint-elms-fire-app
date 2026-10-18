import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { log } from './logger';

export interface MailConfig {
  smtpUrl: string;
  from: string;
  /** Set, mail goes out through Resend's HTTPS API instead of SMTP (hosts that block SMTP ports). */
  resendApiKey?: string;
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
  const resendApiKey = environment.MAIL_RESEND_API_KEY?.trim();
  if (from && /[\r\n]/.test(from)) {
    throw new Error('MAIL_FROM must not contain line breaks');
  }
  if (resendApiKey) {
    // Resend's HTTPS API: nothing to parse but the key's shape; the sender must be a verified
    // Resend address (`onboarding@resend.dev` while the account has no verified domain).
    if (!/^re_[A-Za-z0-9_-]{10,}$/.test(resendApiKey)) throw new Error('MAIL_RESEND_API_KEY is not a Resend API key');
    return { smtpUrl: '', from: from || 'Saint Elms University <onboarding@resend.dev>', resendApiKey };
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

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const IGNORE_NOTE = 'If you did not request this, you can ignore this message.';

/** One self-contained, inline-CSS document: email clients strip <style>, remote fonts and scripts. */
function renderHtml(headline: string, intro: string, buttonLabel: string, url: string): string {
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(headline)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e4e4e7;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;">
<tr><td style="padding:28px 32px 0 32px;font-size:15px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#18181b;">Saint Elms University</td></tr>
<tr><td style="padding:20px 32px 0 32px;font-size:22px;line-height:1.3;font-weight:700;color:#18181b;">${escapeHtml(headline)}</td></tr>
<tr><td style="padding:12px 32px 0 32px;font-size:15px;line-height:1.6;color:#3f3f46;">${escapeHtml(intro)}</td></tr>
<tr><td style="padding:24px 32px 0 32px;"><a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">${escapeHtml(buttonLabel)}</a></td></tr>
<tr><td style="padding:20px 32px 0 32px;font-size:13px;line-height:1.5;color:#52525b;">Or paste this link into your browser:<br><span style="word-break:break-all;color:#18181b;">${safeUrl}</span></td></tr>
<tr><td style="padding:28px 32px 28px 32px;"><div style="border-top:1px solid #e4e4e7;padding-top:16px;font-size:12px;line-height:1.5;color:#71717a;">${IGNORE_NOTE}</div></td></tr>
</table></td></tr></table>
</body></html>`;
}

function template(subject: string, headline: string, intro: string, buttonLabel: string) {
  return {
    subject,
    text: (url: string) => `${intro}\n\n${url}\n\n${IGNORE_NOTE}`,
    html: (url: string) => renderHtml(headline, intro, buttonLabel, url),
  };
}

const templates = {
  verification: () =>
    template(
      'Verify your Saint Elms University email',
      'Verify your email',
      'Confirm this address to finish creating your Saint Elms University account:',
      'Verify email',
    ),
  'password-reset': () =>
    template(
      'Reset your Saint Elms University password',
      'Reset your password',
      'Use this link to choose a new password:',
      'Choose a new password',
    ),
  'magic-link': () =>
    template(
      'Your Saint Elms University sign-in link',
      'Sign in to Saint Elms University',
      'This link signs you in to your Saint Elms University account. It expires in 15 minutes and can be used once:',
      'Sign in',
    ),
} as const;

type TemplateName = keyof typeof templates;

/**
 * The one call the Resend API needs, shaped like a nodemailer transport so the mailer treats
 * both the same way: an accepted send names the recipient, anything else throws.
 */
export function resendTransport(apiKey: string, fetchFn: typeof fetch = fetch): Pick<Transporter, 'sendMail'> {
  return {
    sendMail: async (options: { from?: string; to?: string; subject?: string; text?: string; html?: string }) => {
      const response = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: options.from, to: options.to, subject: options.subject, text: options.text, html: options.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`resend answered ${response.status}`);
      return { accepted: [options.to], rejected: [] };
    },
  } as unknown as Pick<Transporter, 'sendMail'>;
}

/**
 * All sends fail loudly: there is no code path that reports mail as sent without SMTP accepting
 * it. Recipient addresses and links are never logged.
 */
export function createMailer(config: MailConfig, transport?: Transporter, fetchFn: typeof fetch = fetch): Mailer {
  const transporter =
    transport ??
    (config.resendApiKey ? resendTransport(config.resendApiKey, fetchFn) : undefined) ??
    nodemailer.createTransport({
      url: config.smtpUrl,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });

  const send = async (template: TemplateName, to: string, url: string) => {
    const { subject, text, html } = templates[template]();
    try {
      const result = await transporter.sendMail({ from: config.from, to, subject, text: text(url), html: html(url) });
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
