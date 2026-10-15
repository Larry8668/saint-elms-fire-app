import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmPageHtml, withMagicLinkConfirmation } from './account';

const ORIGIN = 'http://localhost:4200';
const CONFIRM_URL = `${ORIGIN}/v1/auth/magic-link/confirm`;
const VERIFY_URL = `${ORIGIN}/v1/auth/magic-link/verify`;

function stubHandler() {
  const calls: Request[] = [];
  const handler = async (request: Request) => {
    calls.push(request);
    return new Response(JSON.stringify({ reached: true, url: request.url, method: request.method }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, handler };
}

const wrapped = () => {
  const stub = stubHandler();
  return { ...stub, wrapper: withMagicLinkConfirmation(stub.handler, ORIGIN) };
};

const postForm = (body: string | URLSearchParams, headers: Record<string, string> = {}) =>
  new Request(CONFIRM_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers },
    body: body.toString(),
  });

test('GET confirm renders a non-consuming same-origin form with the carried fields', async () => {
  const { calls, wrapper } = wrapped();
  const response = await wrapper(new Request(`${CONFIRM_URL}?token=abc123&callbackURL=%2Fdash`));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 0, 'the raw handler is never reached by a public GET');

  const html = await response.text();
  assert.ok(html.includes('method="post"'));
  assert.ok(html.includes('action="/v1/auth/magic-link/confirm"'));
  assert.ok(html.includes('name="token" value="abc123"'));
  assert.ok(html.includes('name="callbackURL" value="/dash"'));
  assert.ok(html.includes('<button type="submit">'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('magic-link/verify'), 'no consuming link or auto-redirect');

  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'/);
});

test('a hostile Host header cannot move the confirm form destination', async () => {
  const { wrapper } = wrapped();
  const response = await wrapper(new Request('https://evil.example/v1/auth/magic-link/confirm?token=abc123'));
  const html = await response.text();
  assert.ok(html.includes('action="/v1/auth/magic-link/confirm"'));
  assert.ok(!html.includes('evil.example'));
});

test('GET confirm rejects malformed links generically', async () => {
  const { calls, wrapper } = wrapped();
  const cases = [
    `${CONFIRM_URL}`,
    `${CONFIRM_URL}?callbackURL=%2F`,
    `${CONFIRM_URL}?token=abc&token=def`,
    `${CONFIRM_URL}?token=abc&unexpected=1`,
    `${CONFIRM_URL}?token=${'x'.repeat(257)}`,
    `${CONFIRM_URL}?token=abc&callbackURL=${'x'.repeat(2049)}`,
  ];
  for (const url of cases) {
    const response = await wrapper(new Request(url));
    assert.equal(response.status, 400, url);
  }
  assert.equal(calls.length, 0);
});

test('HEAD confirm answers the same status with an empty body', async () => {
  const { calls, wrapper } = wrapped();
  const ok = await wrapper(new Request(`${CONFIRM_URL}?token=abc123`, { method: 'HEAD' }));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '');
  const bad = await wrapper(new Request(`${CONFIRM_URL}`, { method: 'HEAD' }));
  assert.equal(bad.status, 400);
  assert.equal(await bad.text(), '');
  assert.equal(calls.length, 0);
});

test('GET and HEAD verify are bounced to the confirm page, never to the consuming endpoint', async () => {
  const { calls, wrapper } = wrapped();
  const urls = [
    `${VERIFY_URL}?token=abc123&callbackURL=%2F`,
    `${VERIFY_URL}/?token=abc123`,
    `${ORIGIN}/v1/auth//magic-link/verify?token=abc123`,
    `${ORIGIN}/v1/auth/magic-link/%76erify?token=abc123`,
  ];
  for (const url of urls) {
    const response = await wrapper(new Request(url));
    assert.equal(response.status, 303, url);
    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(location.origin, ORIGIN);
    assert.equal(location.pathname, '/v1/auth/magic-link/confirm');
    assert.equal(location.searchParams.get('token'), 'abc123');
    assert.ok(!response.headers.get('set-cookie'));
  }
  const head = await wrapper(new Request(`${VERIFY_URL}?token=abc123`, { method: 'HEAD' }));
  assert.equal(head.status, 303);
  assert.equal(calls.length, 0, 'no verify GET ever reaches the raw handler');
});

test('POST confirm requires the configured origin and a bounded urlencoded body', async () => {
  const { calls, wrapper } = wrapped();
  const valid = new URLSearchParams({ token: 'abc123', callbackURL: '/' });

  const missingOrigin = await wrapper(
    new Request(CONFIRM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: valid.toString(),
    }),
  );
  assert.equal(missingOrigin.status, 403);

  const hostile = await wrapper(postForm(valid, { origin: 'https://evil.example' }));
  assert.equal(hostile.status, 403);

  const wrongType = await wrapper(
    new Request(CONFIRM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ token: 'abc123' }),
    }),
  );
  assert.equal(wrongType.status, 415);

  const nearMiss = await wrapper(postForm(valid, { 'content-type': 'application/x-www-form-urlencoded-evil' }));
  assert.equal(nearMiss.status, 415);

  const oversized = await wrapper(postForm(`token=${'x'.repeat(17 * 1024)}`));
  assert.equal(oversized.status, 413);

  for (const body of ['', 'callbackURL=%2F', 'token=a&token=b', 'token=a&extra=1']) {
    const response = await wrapper(postForm(body));
    assert.equal(response.status, 400, body);
  }
  assert.equal(calls.length, 0);

  const withCharset = await wrapper(postForm(valid, { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }));
  assert.equal(withCharset.status, 200);
  assert.equal(calls.length, 1, 'a charset suffix still submits');
});

test('POST confirm forwards a validated GET verify request to the raw handler', async () => {
  const { calls, wrapper } = wrapped();
  const body = new URLSearchParams({ token: 'abc123', newUserCallbackURL: '/welcome' });
  const response = await wrapper(postForm(body, { cookie: 'better-auth.session_token=existing' }));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const internal = calls[0]!;
  assert.equal(internal.method, 'GET');
  const url = new URL(internal.url);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, '/v1/auth/magic-link/verify');
  assert.equal(url.searchParams.get('token'), 'abc123');
  assert.equal(url.searchParams.get('callbackURL'), '/', 'callbackURL defaults to /');
  assert.equal(url.searchParams.get('newUserCallbackURL'), '/welcome');
  assert.equal(internal.headers.get('cookie'), 'better-auth.session_token=existing');
  assert.equal(internal.headers.get('origin'), ORIGIN);
  assert.equal(internal.headers.get('content-type'), null);
  assert.equal(internal.headers.get('content-length'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('other methods on the magic-link paths are refused and other paths delegate', async () => {
  const { calls, wrapper } = wrapped();
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await wrapper(new Request(`${CONFIRM_URL}?token=abc`, { method }));
    assert.equal(response.status, 405, method);
  }
  const postVerify = await wrapper(new Request(VERIFY_URL, { method: 'POST' }));
  assert.equal(postVerify.status, 405);

  const delegated = await wrapper(new Request(`${ORIGIN}/v1/auth/sign-in/email`, { method: 'POST' }));
  assert.equal(delegated.status, 200);
  assert.equal(calls.length, 1);
});

test('a crashing raw handler surfaces a generic unavailable response', async () => {
  const wrapper = withMagicLinkConfirmation(async () => {
    throw new Error('db connection string with hunter2 password');
  }, ORIGIN);
  const response = await wrapper(new Request(`${ORIGIN}/v1/auth/sign-in/email`, { method: 'POST' }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'account_auth_unavailable' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('confirmPageHtml escapes carried field values', () => {
  const html = confirmPageHtml(`${CONFIRM_URL}?token=${encodeURIComponent('"><img src=x>')}&callbackURL=%2F`);
  assert.ok(!html.includes('"><img'));
  assert.ok(html.includes('&quot;&gt;&lt;img'));
});
