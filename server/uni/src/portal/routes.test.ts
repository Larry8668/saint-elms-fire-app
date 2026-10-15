import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { config } from '../config';
import type { AccountAuth } from '../account-auth';
import type { UniDeps } from '../deps';
import { portalRoutes } from './routes';

const withAccount = { accountAuth: { handler: async () => new Response('{}') } as unknown as AccountAuth };

async function app(portalDir?: string) {
  const previous = config.portalDir;
  if (portalDir) config.portalDir = portalDir;
  const deps = withAccount as unknown as UniDeps;
  const server = new Hono();
  server.route('/', portalRoutes(deps));
  return { server, restore: () => { config.portalDir = previous; } };
}

const builtPortal = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-portal-build-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  await writeFile(path.join(dir, 'assets', 'app-12345678.js'), 'console.log(1)');
  return dir;
};

test('the device page is served with a nonce-bound, no-store policy', async () => {
  const { server, restore } = await app();
  const res = await server.request('/device');
  restore();

  assert.equal(res.status, 200);
  const html = await res.text();
  const nonce = res.headers.get('content-security-policy')?.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'script-src must be nonce-bound');
  assert.ok(html.includes(`<script nonce="${nonce}">`), 'the inline script carries the nonce');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const csp = res.headers.get('content-security-policy') ?? '';
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("connect-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("base-uri 'none'"));
  assert.ok(!csp.includes('unsafe-inline'), 'inline execution must not be re-enabled');
  assert.ok(!csp.includes('unsafe-eval'), 'eval must stay off');
});

test('each device page response gets its own nonce', async () => {
  const { server, restore } = await app();
  const first = await server.request('/device');
  const second = await server.request('/device');
  restore();
  const nonceOf = (r: Response) => r.headers.get('content-security-policy')?.match(/nonce-([^']+)'/)?.[1];
  assert.ok(nonceOf(first));
  assert.notEqual(nonceOf(first), nonceOf(second));
});

test('the device page never embeds the code or any token in the served markup', async () => {
  const { server, restore } = await app();
  const res = await server.request('/device?user_code=ABCD-EFGH');
  restore();
  const html = await res.text();
  assert.ok(!html.includes('ABCD-EFGH'), 'the query code is read in script, never written into markup');
  assert.ok(!/(token|secret|password|session)\s*[:=]\s*["'][^"']+["']/i.test(html), 'no credential-shaped literals');
});

test('the device page posts to the device approval endpoints same-origin', async () => {
  const { server, restore } = await app();
  const html = await (await server.request('/device')).text();
  restore();
  assert.ok(html.includes("'/v1/auth/device/' + action"), 'approval posts to the device base');
  assert.ok(html.includes("decide('approve'"), 'approve calls /v1/auth/device/approve');
  assert.ok(html.includes("decide('deny'"), 'deny calls /v1/auth/device/deny');
  assert.ok(html.includes("credentials: 'include'"), 'the session cookie must ride along');
  assert.ok(html.includes('userCode'), 'better-auth expects camelCase userCode');
  assert.ok(html.includes('history.replaceState'), 'the code is cleared from the address bar');
});

test('a code can be typed by hand when the link did not prefill one', async () => {
  const { server, restore } = await app();
  const html = await (await server.request('/device')).text();
  restore();
  // The prompt used to tell people to type a code with no input to type it into.
  assert.ok(html.includes('id="user-code"'), 'there is a real input for the code');
  assert.ok(html.includes('<label class="label" for="user-code">'), 'the input is labelled');
  assert.ok(html.includes('currentCode()'), 'the approve/deny handlers read the live input value');
  // A server error must survive re-enabling the buttons.
  assert.ok(!/refresh\(\)[\s\S]{0,40}say\(''\)/.test(html), 'refreshing the buttons must not clear the status message');
});

test('the onboarding bundle gets a policy that actually permits its own assets', async () => {
  const dir = await builtPortal();
  const { server, restore } = await app(dir);
  const csp = (await server.request('/app/')).headers.get('content-security-policy') ?? '';
  restore();

  // A nonce-less page must not inherit the inline policy: that blocked every script.
  assert.ok(csp.includes("script-src 'self'"), csp);
  assert.ok(csp.includes("style-src 'self'"), csp);
  assert.ok(!csp.includes('script-src \'none\''), csp);
  assert.ok(!csp.includes('undefined'), 'no un-interpolated nonce leaked into the policy');
  // React sets element styles via the style attribute, which style-src-attr governs.
  assert.ok(csp.includes("style-src-attr 'unsafe-inline'"), csp);
  assert.ok(csp.includes("font-src 'self'"), csp);
  assert.ok(csp.includes("frame-ancestors 'none'"), csp);
  assert.ok(!csp.includes('unsafe-eval'), csp);
});

test('the device page keeps its nonce-bound inline policy', async () => {
  const { server, restore } = await app();
  const csp = (await server.request('/device')).headers.get('content-security-policy') ?? '';
  restore();
  assert.ok(csp.includes('script-src \'nonce-'), csp);
  assert.ok(csp.includes('style-src \'nonce-'), csp);
  assert.ok(!csp.includes('unsafe-inline'), csp);
});

test('without a configured account layer both portal surfaces fail closed', async () => {
  const server = new Hono();
  server.route('/', portalRoutes({} as UniDeps));
  for (const url of ['/device', '/app/']) {
    const res = await server.request(url);
    assert.equal(res.status, 503, url);
    assert.equal(((await res.json()) as { error: string }).error, 'account_auth_unavailable', url);
  }
});

test('the onboarding shell and its assets are served from the portal build', async () => {
  const dir = await builtPortal();
  const { server, restore } = await app(dir);

  const shell = await server.request('/app/');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type') ?? '', /text\/html/);
  assert.ok((await shell.text()).includes('shell'));

  const script = await server.request('/app/assets/app-12345678.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  restore();
});

test('an unchanged asset revalidates to 304 and a changed one does not', async () => {
  const dir = await builtPortal();
  const { server, restore } = await app(dir);
  const first = await server.request('/app/index.html');
  const etag = first.headers.get('etag');
  assert.ok(etag);

  const revalidated = await server.request('/app/index.html', { headers: { 'if-none-match': etag } });
  assert.equal(revalidated.status, 304);

  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>changed</title>');
  const stale = await server.request('/app/index.html', { headers: { 'if-none-match': etag } });
  assert.equal(stale.status, 200, 'a redeployed asset must not be answered with a stale 304');
  restore();
});

test('a missing sub-path is a 404 and never falls back to the shell', async () => {
  const dir = await builtPortal();
  const { server, restore } = await app(dir);
  const missing = await server.request('/app/nope.js');
  restore();
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: string }).error, 'not_found');
});

test('a traversal attempt through the portal mount cannot read outside the build', async () => {
  const dir = await builtPortal();
  const { server, restore } = await app(dir);
  await writeFile(path.join(dir, '..', 'sef-portal-escape.txt'), 'secret');
  for (const url of ['/app/../sef-portal-escape.txt', '/app/..%2f..%2fetc%2fpasswd']) {
    const res = await server.request(url);
    assert.ok(res.status === 404 || res.status === 400, `${url} -> ${res.status}`);
    assert.ok(!(await res.text()).includes('root:'), url);
  }
  restore();
});
