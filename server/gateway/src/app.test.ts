import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { serve } from '@hono/node-server';
import type { Logger } from '@sef/shared';
import { createGatewayApp } from './app';
import type { GatewayConfig } from './config';
import { SubjectLimits } from './limits';
import { UpstreamPool } from './pool';
import { mintGatewayToken, parseGatewayDevTokens } from '@sef/shared/node';

const SECRET = 's'.repeat(40);
const DEV = 'dev-token-for-tests-0001';
const closers: Array<() => void> = [];
after(() => closers.forEach((close) => close()));

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A fake Ollama worker on an ephemeral loopback port. */
async function fakeUpstream(handler: Handler) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`);
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const memoryLog = () => {
  const lines: string[] = [];
  const write = (event: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ event, ...fields }));
  const log: Logger = { debug: write, info: write, warn: write, error: write };
  return { log, lines };
};

async function gateway(upstreams: string[], overrides: Partial<GatewayConfig> = {}) {
  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    tokenSecret: SECRET,
    devTokens: parseGatewayDevTokens(`${DEV}:dev-student`),
    metricsToken: 'metrics-token-0001',
    upstreams: upstreams.map((url) => ({ url, kind: 'ollama', maxInFlight: 4 })),
    models: ['gemma4:e2b', 'embeddinggemma'],
    maxBodyBytes: 1024 * 1024,
    queueTimeoutMs: 100,
    healthIntervalMs: 60_000,
    failureThreshold: 2,
    cooldownMs: 60_000,
    ratePerMinute: 100,
    maxConcurrentPerSubject: 4,
    dailyTokenBudget: 1e9,
    ...overrides,
  };
  const pool = new UpstreamPool(config.upstreams, config);
  const limits = new SubjectLimits({ ratePerMinute: config.ratePerMinute, maxConcurrent: config.maxConcurrentPerSubject, dailyTokenBudget: config.dailyTokenBudget });
  const { log, lines } = memoryLog();
  const app = createGatewayApp({ config, pool, limits, log });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = mintGatewayToken(SECRET, { sub: 'acct_test', vm: 'm_vm1', ttlSeconds: 600 });
  const call = (path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}) =>
    fetch(`${base}${path}`, {
      method: init.json !== undefined ? 'POST' : (init.method ?? 'GET'),
      headers: {
        'content-type': 'application/json',
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? token}` }),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: init.signal,
    });
  return { base, call, pool, limits, lines };
}

const ok = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: { content: 'hi' }, done: true, prompt_eval_count: 5, eval_count: 7 }));
};

test('requests without a valid token get 401 and never reach a worker', async () => {
  const up = await fakeUpstream(ok);
  const gw = await gateway([up.url]);
  assert.equal((await gw.call('/api/chat', { json: { model: 'gemma4:e2b' }, token: null })).status, 401);
  assert.equal((await gw.call('/api/chat', { json: { model: 'gemma4:e2b' }, token: 'nope' })).status, 401);
  assert.equal((await gw.call('/api/tags', { token: mintGatewayToken('x'.repeat(40), { sub: 'a', ttlSeconds: 60 }) })).status, 401);
  assert.equal((await gw.call('/api/chat', { json: { model: 'gemma4:e2b' }, token: DEV })).status, 200, 'dev tokens work');
  assert.equal(up.seen.length, 1);
  assert.equal((await gw.call('/health', { token: null })).status, 200);
});

test('only allowlisted endpoints and models pass; the worker never sees the caller token', async () => {
  const up = await fakeUpstream((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'gemma4:e2b' }, { name: 'embeddinggemma:latest' }, { name: 'secret-model' }] }));
    } else ok(req, res);
  });
  const gw = await gateway([up.url], { upstreamToken: 'worker-key' });
  for (const [path, method] of [['/api/pull', 'POST'], ['/api/delete', 'DELETE'], ['/api/create', 'POST'], ['/api/push', 'POST'], ['/api/ps', 'GET'], ['/api/chat', 'GET'], ['/api/chat/../pull', 'POST']]) {
    const res = await gw.call(path, method === 'POST' ? { json: { model: 'gemma4:e2b' } } : { method });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await gw.call('/api/chat', { json: { model: 'llama3' } })).status, 403);
  const openai = await gw.call('/v1/chat/completions', { json: { model: 'llama3' } });
  assert.equal(openai.status, 403);
  assert.equal(((await openai.json()) as { error: { code: string } }).error.code, 'model_not_allowed');
  assert.equal((await gw.call('/api/chat', { json: {} })).status, 403, 'a model is required');
  assert.equal((await gw.call('/api/chat', { body: 'not json', method: 'POST' })).status, 400);
  assert.equal((await gw.call('/api/embed', { json: { model: 'embeddinggemma:latest', input: ['x'] } })).status, 200);
  const tags = (await (await gw.call('/api/tags')).json()) as { models: Array<{ name: string }> };
  assert.deepEqual(tags.models.map((m) => m.name), ['gemma4:e2b', 'embeddinggemma:latest']);
  assert.deepEqual(up.seen, ['POST /api/embed auth=Bearer worker-key', 'GET /api/tags auth=Bearer worker-key']);
});

test('a share screen reaches the worker with its logprobs and options untouched', async () => {
  let forwarded = '';
  const up = await fakeUpstream((req, res, body) => {
    forwarded = body;
    ok(req, res);
  });
  const gw = await gateway([up.url], { models: ['shieldgemma:2b'] });
  // The engine's ShieldGemma call (engine/src/shares/screen.ts): one token, scored by P(Yes).
  const screen = { model: 'shieldgemma:2b', messages: [{ role: 'user', content: 'q' }], stream: false, logprobs: true, top_logprobs: 10, options: { temperature: 0, num_predict: 1 } };
  assert.equal((await gw.call('/api/chat', { json: screen })).status, 200);
  assert.deepEqual(JSON.parse(forwarded), screen, 'the gateway allowlists routes and models, never body fields');
});

test('fails over from a down worker and a 5xx worker, tripping their circuits', async () => {
  const dead = 'http://127.0.0.1:9'; // discard port: connection refused
  const broken = await fakeUpstream((_req, res) => {
    res.writeHead(503);
    res.end('overloaded');
  });
  const good = await fakeUpstream(ok);
  const gw = await gateway([dead, broken.url, good.url], { failureThreshold: 1 });
  for (let i = 0; i < 3; i++) assert.equal((await gw.call('/api/chat', { json: { model: 'gemma4:e2b' } })).status, 200);
  const [u1, u2, u3] = gw.pool.snapshot();
  assert.equal(u3.served, 3);
  assert.equal(u1.healthy, false, 'the dead worker is skipped once its circuit trips');
  assert.equal(u2.healthy, false);
  const before = broken.seen.length;
  await gw.call('/api/chat', { json: { model: 'gemma4:e2b' } });
  assert.equal(broken.seen.length, before, 'an open circuit gets no traffic');
  assert.deepEqual(gw.pool.snapshot().map((u) => u.inFlight), [0, 0, 0]);
});

test('no healthy worker answers 503 with Retry-After', async () => {
  const gw = await gateway(['http://127.0.0.1:9'], { failureThreshold: 1 });
  await gw.call('/api/chat', { json: { model: 'gemma4:e2b' } });
  const res = await gw.call('/api/chat', { json: { model: 'gemma4:e2b' } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '5');
});

test('rate, concurrency and budget limits answer 429 with Retry-After', async () => {
  const up = await fakeUpstream(ok);
  const rate = await gateway([up.url], { ratePerMinute: 1 });
  assert.equal((await rate.call('/api/chat', { json: { model: 'gemma4:e2b' } })).status, 200);
  const limited = await rate.call('/api/chat', { json: { model: 'gemma4:e2b' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  const budget = await gateway([up.url], { dailyTokenBudget: 10 });
  assert.equal((await (await budget.call('/api/chat', { json: { model: 'gemma4:e2b' } })).text()).length > 0, true);
  assert.equal(budget.limits.snapshot()[0].tokensToday, 12, 'counted from prompt_eval_count + eval_count');
  const over = await budget.call('/api/chat', { json: { model: 'gemma4:e2b' } });
  assert.equal(over.status, 429);
  assert.equal(((await over.json()) as { code: string }).code, 'limit_budget');

  const hold: ServerResponse[] = [];
  const slow = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"message":{"content":"a"}}\n');
    hold.push(res);
  });
  const conc = await gateway([slow.url], { maxConcurrentPerSubject: 1 });
  const first = await conc.call('/api/chat', { json: { model: 'gemma4:e2b' } });
  assert.equal(first.status, 200);
  assert.equal((await conc.call('/api/chat', { json: { model: 'gemma4:e2b' } })).status, 429);
  hold[0].end('{"done":true,"eval_count":1}\n');
  await first.text();
  assert.equal(conc.limits.snapshot()[0].concurrent, 0, 'the stream released its slot');
});

test('streams chunk by chunk without buffering, and logs no content', async () => {
  const SECRET_PROMPT = 'PROMPT-CANARY-7731';
  const SECRET_REPLY = 'REPLY-CANARY-4410';
  const up = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let i = 0;
    const timer = setInterval(() => {
      if (i < 3) res.write(`${JSON.stringify({ message: { content: `${SECRET_REPLY}-${i++}` }, done: false })}\n`);
      else {
        clearInterval(timer);
        res.end(`${JSON.stringify({ done: true, prompt_eval_count: 11, eval_count: 3 })}\n`);
      }
    }, 120);
  });
  const gw = await gateway([up.url]);
  const started = Date.now();
  const res = await gw.call('/api/chat', { json: { model: 'gemma4:e2b', stream: true, messages: [{ role: 'user', content: SECRET_PROMPT }] } });
  assert.equal(res.status, 200);
  const arrivals: number[] = [];
  let text = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    arrivals.push(Date.now() - started);
    text += Buffer.from(chunk).toString();
  }
  assert.ok(text.includes(`${SECRET_REPLY}-2`));
  assert.ok(arrivals.length >= 3, `chunks arrived separately: ${arrivals}`);
  assert.ok(arrivals[0] < 300, `first chunk arrived before the stream finished: ${arrivals}`);
  assert.ok(arrivals.at(-1)! - arrivals[0] >= 250, `spread over time: ${arrivals}`);

  const done = gw.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'gw_request')!;
  assert.deepEqual(
    { sub: done.sub, vm: done.vm, model: done.model, status: done.status, tokens: done.tokens, estimated: done.estimated },
    { sub: 'acct_test', vm: 'm_vm1', model: 'gemma4:e2b', status: 200, tokens: 14, estimated: false },
  );
  const all = gw.lines.join('\n');
  assert.ok(!all.includes('CANARY'), 'no prompt or response text in logs');
  const metrics = await gw.call('/metrics', { token: 'metrics-token-0001' });
  assert.equal(metrics.status, 200);
  const body = await metrics.text();
  assert.ok(body.includes('acct_test') && !body.includes('CANARY'));
  assert.equal((await gw.call('/metrics')).status, 401, 'a student token cannot read metrics');
});

test('a client abort cancels the upstream request', async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const up = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'), 50);
    res.on('close', () => {
      clearInterval(timer);
      upstreamClosed();
    });
  });
  const gw = await gateway([up.url]);
  const controller = new AbortController();
  const res = await gw.call('/v1/chat/completions', { json: { model: 'gemma4:e2b', stream: true }, signal: controller.signal });
  const reader = res.body!.getReader();
  await reader.read();
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream never saw the abort')), 3000))]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gw.pool.snapshot()[0].inFlight, 0);
  assert.equal(gw.limits.snapshot()[0].concurrent, 0);
  assert.equal(gw.pool.snapshot()[0].healthy, true, 'a client abort is not a worker failure');
  const usage = gw.limits.snapshot()[0].tokensToday;
  assert.ok(usage > 0, 'partial streams are still billed (estimated)');
});
