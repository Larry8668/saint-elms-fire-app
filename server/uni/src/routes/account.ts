import { log } from '../logger';

const CONFIRM_PATH = '/v1/auth/magic-link/confirm';
const VERIFY_PATH = '/v1/auth/magic-link/verify';

const MAGIC_LINK_FIELDS = ['token', 'callbackURL', 'newUserCallbackURL', 'errorCallbackURL'] as const;
const MAX_TOKEN_LENGTH = 256;
const MAX_CALLBACK_LENGTH = 2048;
const MAX_FORM_BYTES = 16 * 1024;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'referrer-policy': 'strict-origin',
  'x-robots-tag': 'noindex',
  'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

type MagicLinkFields = Partial<Record<(typeof MAGIC_LINK_FIELDS)[number], string>> & { token: string };

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function canonicalPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return trimmed;
}

function validateFields(params: URLSearchParams): MagicLinkFields | null {
  const fields: Partial<Record<(typeof MAGIC_LINK_FIELDS)[number], string>> = {};
  const seen = new Set<string>();
  for (const [name, value] of params.entries()) {
    if (!(MAGIC_LINK_FIELDS as readonly string[]).includes(name)) return null;
    if (seen.has(name)) return null;
    seen.add(name);
    if (name === 'token' ? value.length === 0 || value.length > MAX_TOKEN_LENGTH : value.length > MAX_CALLBACK_LENGTH) {
      return null;
    }
    fields[name as (typeof MAGIC_LINK_FIELDS)[number]] = value;
  }
  if (!seen.has('token')) return null;
  return fields as MagicLinkFields;
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
  const body = request.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Minimal confirmation page; no external assets, no scripts, no auto-redirect. */
export function confirmPageHtml(confirmUrl: string): string {
  const params = new URL(confirmUrl).searchParams;
  const inputs = MAGIC_LINK_FIELDS.filter((name) => params.has(name))
    .map((name) => `<input type="hidden" name="${name}" value="${escapeAttribute(params.get(name) ?? '')}"/>`)
    .join('');
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
<form method="post" action="${CONFIRM_PATH}">${inputs}<button type="submit">Continue to sign in</button></form>
<p>This link can only be used once. If you did not request it, you can close this page.</p>
</main>
</body>
</html>
`;
}

/**
 * Non-consuming hop for magic links: email scanners can fetch the confirm page freely; only a
 * same-origin POST from that page reaches the consuming verify endpoint. Public GETs to the
 * verify path (including trailing-slash, double-slash and percent-encoded aliases) are bounced
 * to the confirm page so no GET ever consumes the single-use token.
 */
export function withMagicLinkConfirmation(
  handler: (request: Request) => Promise<Response>,
  publicOrigin: string,
): (request: Request) => Promise<Response> {
  const confirmGet = async (request: Request, url: URL): Promise<Response> => {
    if (request.method === 'HEAD') {
      const status = validateFields(url.searchParams) ? 200 : 400;
      return new Response(null, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' } });
    }
    if (!validateFields(url.searchParams)) return new Response('invalid confirmation link', { status: 400 });
    return new Response(confirmPageHtml(request.url), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' },
    });
  };

  const verifyGet = (url: URL): Response => {
    if (!validateFields(url.searchParams)) return new Response('invalid confirmation link', { status: 400 });
    const target = new URL(CONFIRM_PATH, publicOrigin);
    for (const [name, value] of url.searchParams.entries()) target.searchParams.set(name, value);
    return new Response(null, { status: 303, headers: { location: target.toString() } });
  };

  const confirmPost = async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== publicOrigin) return new Response('forbidden', { status: 403 });
    const mediaType = (request.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (mediaType !== 'application/x-www-form-urlencoded') {
      return new Response('unsupported media type', { status: 415 });
    }
    const body = await readBoundedBody(request);
    if (body === null) return new Response('payload too large', { status: 413 });
    const fields = validateFields(new URLSearchParams(body));
    if (!fields) return new Response('invalid confirmation submission', { status: 400 });
    const target = new URL(VERIFY_PATH, publicOrigin);
    target.searchParams.set('token', fields.token);
    target.searchParams.set('callbackURL', fields.callbackURL ?? '/');
    if (fields.newUserCallbackURL !== undefined) target.searchParams.set('newUserCallbackURL', fields.newUserCallbackURL);
    if (fields.errorCallbackURL !== undefined) target.searchParams.set('errorCallbackURL', fields.errorCallbackURL);
    const headers = new Headers(request.headers);
    headers.delete('content-type');
    headers.delete('content-length');
    return handler(new Request(target, { method: 'GET', headers }));
  };

  return async (request) => {
    try {
      const path = canonicalPath(new URL(request.url).pathname);
      let response: Response;
      if (path === CONFIRM_PATH) {
        if (request.method === 'GET' || request.method === 'HEAD') response = await confirmGet(request, new URL(request.url));
        else if (request.method === 'POST') response = await confirmPost(request);
        else response = new Response(null, { status: 405, headers: { allow: 'GET, HEAD, POST' } });
      } else if (path === VERIFY_PATH) {
        if (request.method === 'GET' || request.method === 'HEAD') response = verifyGet(new URL(request.url));
        else response = new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
      } else {
        response = await handler(request);
      }
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
      return response;
    } catch {
      log.error('account_auth_failed');
      return new Response(JSON.stringify({ error: 'account_auth_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json', ...SECURITY_HEADERS },
      });
    }
  };
}
