import { parseArgs } from 'node:util';
import { mintGatewayToken } from '@sef/shared/node';

/**
 * `GATEWAY_TOKEN_SECRET=… pnpm --filter @sef/gateway stream-check -- --url https://<gateway>`:
 * checks a gateway end to end the way a session VM uses it, typically through a public tunnel
 * (docs/demo-hosted.md). It confirms that a request without a token gets 401, then streams one
 * short chat on the native `/api/chat` (NDJSON: what the engine speaks) and on
 * `/v1/chat/completions` (SSE), and reports when each chunk arrived. A buffering proxy shows up
 * as every chunk arriving at once. Prints no token. Exit 1 on a failure or a buffered stream.
 */
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    model: { type: 'string', default: 'gemma4:e2b' },
    predict: { type: 'string', default: '48' },
  },
});
const secret = process.env.GATEWAY_TOKEN_SECRET;
if (!secret || !values.url) {
  console.error('usage: GATEWAY_TOKEN_SECRET=... stream-check --url <gateway root> [--model gemma4:e2b] [--predict 48]');
  process.exit(1);
}
const base = values.url.replace(/\/+$/, '').replace(/\/v1$/, '');
const token = mintGatewayToken(secret, { sub: 'demo-stream-check', ttlSeconds: 300 });
const prompt = 'Count from one to twenty in words, separated by spaces.';

interface StreamResult {
  status: number;
  chunks: number;
  firstMs: number;
  lastMs: number;
  distinctArrivals: number;
}

async function stream(path: string, body: unknown): Promise<StreamResult> {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const arrivals: number[] = [];
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const read = await reader?.read();
    if (!read || read.done) break;
    const at = performance.now() - started;
    pending += decoder.decode(read.value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    // One content-bearing event per line: NDJSON objects or SSE `data:` lines.
    for (const line of lines) if (line.trim() && !line.includes('[DONE]') && (line.startsWith('{') || line.startsWith('data:'))) arrivals.push(at);
  }
  const rounded = new Set(arrivals.map((ms) => Math.round(ms / 25)));
  return { status: res.status, chunks: arrivals.length, firstMs: arrivals[0] ?? 0, lastMs: arrivals.at(-1) ?? 0, distinctArrivals: rounded.size };
}

async function main(): Promise<number> {
  let failed = false;
  const open = await fetch(`${base}/api/tags`);
  console.log(`no token: ${open.status} ${open.status === 401 ? '(refused, as it must be)' : 'UNEXPECTED'}`);
  if (open.status !== 401) failed = true;
  const predict = Number(values.predict);
  const checks: Array<[string, string, unknown]> = [
    ['native /api/chat (NDJSON)', '/api/chat', { model: values.model, stream: true, think: false, messages: [{ role: 'user', content: prompt }], options: { num_predict: predict } }],
    ['/v1/chat/completions (SSE)', '/v1/chat/completions', { model: values.model, stream: true, max_tokens: predict, messages: [{ role: 'user', content: prompt }] }],
  ];
  for (const [label, path, body] of checks) {
    const r = await stream(path, body);
    const span = r.lastMs - r.firstMs;
    // Incremental: many chunks spread over time, not one burst at the end.
    const incremental = r.status === 200 && r.chunks >= 5 && r.distinctArrivals >= Math.min(5, r.chunks) && span > 100;
    console.log(
      `${label}: status ${r.status}, ${r.chunks} chunks, first after ${Math.round(r.firstMs)} ms, spread over ${Math.round(span)} ms in ${r.distinctArrivals} distinct arrivals — ${incremental ? 'streams incrementally' : 'NOT incremental'}`,
    );
    if (!incremental) failed = true;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`stream-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
