export type Banner = { tone: 'success' | 'info' | 'error'; title?: string; body: string };

/** Which email a "check your inbox" screen is waiting on. */
export type MailReason = 'verify' | 'magic-link' | 'reset';

export const MAIL_COPY: Record<MailReason, { title: string; body: string; resend: string }> = {
  verify: {
    title: 'Verify your email address',
    body: 'Your account exists, but an unverified address cannot apply to the programme. Open the link we sent to finish.',
    resend: 'Resend the verification email',
  },
  'magic-link': {
    title: 'Check your email',
    body: 'We sent a sign-in link. Opening it signs you in here; the link works once and expires in 15 minutes.',
    resend: 'Send the link again',
  },
  reset: {
    title: 'Check your email',
    body: 'If that address has an account, a password reset link is on its way. The link reopens this page with a single-use token.',
    resend: 'Send the reset link again',
  },
};