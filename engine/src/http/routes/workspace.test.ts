import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { EngineEnv } from '../context';
import { isHostedWorkspace, workspaceRoutes } from './workspace';

const HOSTED = { ENGINE_PUBLIC_HOST: '4100-abc.instabox.tech', ENGINE_SEAT_OWNER: 'user_1' };

/** A stand-in university that records what the engine relayed and answers as scripted. */
async function fakeUni(answer: (method: string, path: string) => { status: number; body?: unknown } | 'drop') {
  const seen: Array<{ method: string; path: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization });
    const a = answer(req.method!, req.url!);
    if (a === 'drop') return req.socket.destroy();
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(a.body === undefined ? '' : JSON.stringify(a.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function app(uniUrl: string, env: NodeJS.ProcessEnv, opts: { limited?: boolean; uniToken?: string | undefined } = {}) {
  const deps = {
    settings: { get: async () => ({ uniServerUrl: uniUrl }) },
    auth: {
      resolve: async (token: string) =>
        token === 'engine-tok' ? { profile: { id: 'p1' }, mode: 'online', access: opts.limited ? { mode: 'limited', reason: 'suspended' } : { mode: 'full' } } : null,
      uniToken: async () => ('uniToken' in opts ? opts.uniToken : 'uni-secret-token'),
    },
    workspaces: { get: async () => ({}) },
  };
  const server = new Hono<EngineEnv>();
  server.route('/api', workspaceRoutes(deps as never, env));
  const call = (method: string, path: string, token = 'engine-tok') => server.request(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return call;
}

test('hosted means a public host and a seat owner; anything less is a local engine', () => {
  assert.equal(isHostedWorkspace(HOSTED), true);
  assert.equal(isHostedWorkspace({ ENGINE_PUBLIC_HOST: HOSTED.ENGINE_PUBLIC_HOST }), false);
  assert.equal(isHostedWorkspace({ ENGINE_SEAT_OWNER: 'user_1' }), false);
  assert.equal(isHostedWorkspace({ ENGINE_PUBLIC_HOST: '127.0.0.1', ENGINE_SEAT_OWNER: 'u' }), false);
});

test('the heartbeat and the end are relayed with the profile’s own uni credential, never a session id', async () => {
  const uni = await fakeUni((method) => ({ status: method === 'DELETE' ? 202 : 200, body: { id: 'ses_1', state: method === 'DELETE' ? 'stopping' : 'ready', url: 'https://x' } }));
  try {
    const call = app(uni.url, HOSTED);
    const info = await call('GET', '/api/workspace');
    assert.deepEqual(await info.json(), { hosted: true, portalUrl: `${uni.url}/app/` });

    const beat = await call('POST', '/api/workspace/heartbeat');
    assert.equal(beat.status, 200);
    assert.deepEqual(await beat.json(), { ok: true, state: 'ready' }, 'only the state comes back: no URL, no id');
    const end = await call('DELETE', '/api/workspace');
    assert.deepEqual(await end.json(), { ok: true, state: 'stopping' });

    assert.deepEqual(
      uni.seen.map((r) => [r.method, r.path, r.auth]),
      [
        ['POST', '/v1/session/heartbeat', 'Bearer uni-secret-token'],
        ['DELETE', '/v1/session', 'Bearer uni-secret-token'],
      ],
    );
  } finally {
    await uni.close();
  }
});

test('a local engine relays nothing, and only a signed-in profile may ask', async () => {
  const uni = await fakeUni(() => ({ status: 200, body: { state: 'ready' } }));
  try {
    const local = app(uni.url, {});
    assert.deepEqual(await (await local('GET', '/api/workspace')).json(), { hosted: false, portalUrl: null });
    assert.equal((await local('POST', '/api/workspace/heartbeat')).status, 404);
    assert.equal((await local('DELETE', '/api/workspace')).status, 404);
    const hosted = app(uni.url, HOSTED);
    assert.equal((await hosted('POST', '/api/workspace/heartbeat', '')).status, 401);
    assert.equal((await hosted('DELETE', '/api/workspace', 'guessed')).status, 401);
    assert.equal(uni.seen.length, 0);
  } finally {
    await uni.close();
  }
});

test('a read-only (limited) session still keeps its lease and may end it', async () => {
  const uni = await fakeUni(() => ({ status: 200, body: { state: 'ready' } }));
  try {
    const call = app(uni.url, HOSTED, { limited: true });
    assert.equal((await call('POST', '/api/workspace/heartbeat')).status, 200);
    assert.equal((await call('DELETE', '/api/workspace')).status, 200);
  } finally {
    await uni.close();
  }
});

test('university answers map to typed JSON errors (so the client waker never mistakes them for the edge)', async () => {
  for (const [answer, status, code] of [
    [{ status: 404, body: { error: 'no_session' } }, 410, 'workspace_ended'],
    [{ status: 401, body: { error: 'unauthenticated' } }, 403, 'uni_session_expired'],
    [{ status: 500, body: { error: 'internal_error' } }, 502, 'uni_unreachable'],
    ['drop', 502, 'uni_unreachable'],
  ] as const) {
    const uni = await fakeUni(() => answer);
    try {
      const res = await app(uni.url, HOSTED)('POST', '/api/workspace/heartbeat');
      assert.equal(res.status, status);
      assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
      assert.equal(((await res.json()) as { code: string }).code, code);
    } finally {
      await uni.close();
    }
  }
  const call = app('http://127.0.0.1:9', HOSTED, { uniToken: undefined });
  const res = await call('POST', '/api/workspace/heartbeat');
  assert.equal(((await res.json()) as { code: string }).code, 'uni_session_expired', 'no stored credential: sign in again');
});
