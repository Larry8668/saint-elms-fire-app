import type { Context } from 'hono';
import type { AppEnv } from '../auth';

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal confirmation page; no external assets, no scripts, no auto-redirect. */
export function confirmPageHtml(verifyHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm sign-in — Saint Elms University</title>
</head>
<body>
<main>
<h1>Confirm your sign-in</h1>
<p>If you requested a sign-in link for Saint Elms University, continue below.</p>
<p><a href="${escapeAttribute(verifyHref)}" rel="nofollow">Continue to sign in</a></p>
<p>This link can only be used once. If you did not request it, you can close this page.</p>
</main>
</body>
</html>
`;
}

/**
 * Non-consuming hop for magic links: email scanners can fetch this page freely; only a real
 * click performs the GET to the consuming verify endpoint. Same query string, verify path.
 */
export function magicLinkConfirm(c: Context<AppEnv>) {
  const verifyUrl = new URL(c.req.url);
  verifyUrl.pathname = '/v1/auth/magic-link/verify';
  return c.html(confirmPageHtml(verifyUrl.toString()), 200, {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
  });
}
