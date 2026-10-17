import { createHash, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@sef/shared';
import { Hono, type Context } from 'hono';
import type { GatewayConfig, UpstreamKind } from './config';
import { SubjectLimits } from './limits';
import { UpstreamPool, type Upstream } from './pool';
import { verifyGatewayToken, type GatewayClaims } from '@sef/shared/node';
import { UsageMeter } from './usage';

interface Route {
  method: 'GET' | 'POST';
  /** Which workers can serve it: the Ollama native API exists only on Ollama workers. */
  kind: UpstreamKind | 'any';
  /** POST bodies must name an allowlisted model. */
  model: boolean;
  /** Listing endpoints are filtered down to the allowlist. */
  list?: 'ollama' | 'openai';
}

/**
 * The whole surface the engine needs, and nothing else: no pull, push, create, copy,
 * delete, ps or blob routes ever reach a worker.
 */
const ROUTES: Record<string, Route> = {
  '/api/chat': { method: 'POST', kind: 'ollama', model: true },
  '/api/generate': { method: 'POST', kind: 'ollama', model: true },
  '/api/embed': { method: 'POST', kind: 'ollama', model: true },
  '/api/embeddings': { method: 'POST', kind: 'ollama', model: true },
  '/api/show': { method: 'POST', kind: 'ollama', model: true },
  '/api/tags': { method: 'GET', kind: 'ollama', model: false, list: 'ollama' },
  '/api/version': { method: 'GET', kind: 'ollama', model: false },
  '/v1/chat/completions': { method: 'POST', kind: 'any', model: true },
  '/v1/completions': { method: 'POST', kind: 'any', model: true },
  '/v1/embeddings': { method: 'POST', kind: 'any', model: true },
  '/v1/models': { method: 'GET', kind: 'any', model: false, list: 'openai' },
};

export interface GatewayDeps {
  config: GatewayConfig;
  pool: UpstreamPool;
  limits: SubjectLimits;
  log: Logger;
}

const normalizeModel = (name: string) => name.trim().replace(/:latest$/, '');
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Errors in the shape each client family parses: Ollama wants a string, OpenAI an object. */
function fail(c: Context, status: number, code: string, message: string, retryAfter?: number) {
  if (retryAfter !== undefined) c.header('retry-after', String(retryAfter));
  const body = c.req.path.startsWith('/v1/') ? { error: { message, type: code, code } } : { error: message, code };
  return c.json(body, status as 400);
}

async function readBody(req: Request, max: number): Promise<Uint8Array | 'too_large'> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) return 'too_large';
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) return 'too_large';
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createGatewayApp({ config, pool, limits, log }: GatewayDeps) {
  const app = new Hono();
  const allowed = new Set(config.models.map(normalizeModel));
  const aliases = new Map(Object.entries(config.modelAliases ?? {}));
  const metricsDigest = config.metricsToken ? digest(config.metricsToken) : undefined;
  const upstreamAuth: Record<string, string> = config.upstreamToken ? { authorization: `Bearer ${config.upstreamToken}` } : {};

  /** The allowlisted entries, plus an entry under each alias whose served model is listed. */
  function withAliases<K extends 'name' | 'id'>(entries: Array<Partial<Record<K, string>>>, key: K) {
    const kept = entries.filter((m) => allowed.has(normalizeModel(m[key] ?? '')));
    const listed = new Set(kept.map((m) => normalizeModel(m[key] ?? '')));
    for (const [from, to] of aliases) {
      const served = kept.find((m) => normalizeModel(m[key] ?? '') === to);
      if (served && !listed.has(from)) {
        kept.push({ ...served, [key]: from, ...(key === 'name' && 'model' in served ? { model: from } : {}) });
        listed.add(from);
      }
    }
    return kept;
  }

  app.get('/health', (c) => {
    const healthy = pool.snapshot().filter((u) => u.healthy).length;
    return c.json({ ok: true, upstreams: { healthy, total: pool.upstreams.length } });
  });

  app.get('/metrics', (c) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!metricsDigest || !match || !timingSafeEqual(digest(match[1]), metricsDigest)) return fail(c, 401, 'unauthorized', 'metrics token required');
    return c.json({ upstreams: pool.snapshot(), subjects: limits.snapshot(), models: [...allowed] });
  });

  app.all('*', async (c) => {
    const started = Date.now();
    const path = c.req.path;
    const auth = verifyGatewayToken(c.req.header('authorization'), { secret: config.tokenSecret, devTokens: config.devTokens });
    if (!auth.ok) {
      log.info('gw_unauthorized', { path, reason: auth.reason });
      return fail(c, 401, 'unauthorized', 'a valid gateway token is required');
    }
    const who: Pick<GatewayClaims, 'sub' | 'vm'> = { sub: auth.claims.sub, ...(auth.claims.vm ? { vm: auth.claims.vm } : {}) };

    const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (!route || route.method !== c.req.method) {
      log.info('gw_rejected', { ...who, path, reason: 'route' });
      return fail(c, 404, 'not_allowed', 'this endpoint is not served by the gateway');
    }

    let body: Uint8Array | undefined;
    let model: string | undefined;
    let servedAs: string | undefined;
    if (route.method === 'POST') {
      const read = await readBody(c.req.raw, config.maxBodyBytes);
      if (read === 'too_large') return fail(c, 413, 'too_large', 'request body is too large');
      body = read;
      let parsed: { model?: unknown; name?: unknown };
      try {
        parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { model?: unknown; name?: unknown };
        const named = parsed.model ?? parsed.name;
        model = typeof named === 'string' ? named : undefined;
      } catch {
        return fail(c, 400, 'bad_request', 'request body must be JSON');
      }
      if (route.model && (!model || !allowed.has(normalizeModel(model)))) {
        log.info('gw_rejected', { ...who, path, model: model?.slice(0, 80), reason: 'model' });
        return fail(c, 403, 'model_not_allowed', 'this model is not served by the gateway');
      }
      const target = model === undefined ? undefined : aliases.get(normalizeModel(model));
      if (route.model && target) {
        // Rewrite only the field that named the model; the rest of the body is passed as sent.
        if (typeof parsed.model === 'string') parsed.model = target;
        else parsed.name = target;
        body = Buffer.from(JSON.stringify(parsed));
        servedAs = target;
      }
    }

    const admission = limits.admit(who.sub);
    if (!admission.ok) {
      log.info('gw_limited', { ...who, path, model, reason: admission.reason });
      return fail(c, 429, `limit_${admission.reason}`, `${admission.reason} limit reached`, admission.retryAfterSeconds);
    }

    const clientSignal = c.req.raw.signal;
    const tried = new Set<string>();
    let lastResponse: Response | undefined;
    let upstream: Upstream | undefined;
    let abort = new AbortController();
    for (;;) {
      const got = await pool.acquire(route.kind, config.queueTimeoutMs, tried, clientSignal);
      if (!got.ok) break;
      const candidate = got.upstream;
      upstream = candidate;
      tried.add(candidate.id);
      abort = new AbortController();
      const onClientAbort = () => abort.abort();
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
      try {
        const res = await fetch(`${candidate.url}${path}`, {
          method: route.method,
          headers: { 'content-type': 'application/json', accept: c.req.header('accept') ?? '*/*', ...upstreamAuth },
          body: body as RequestInit['body'],
          signal: abort.signal,
        });
        if (res.status >= 500 && pool.upstreams.some((u) => !tried.has(u.id) && (route.kind === 'any' || u.kind === route.kind) && pool.admits(u))) {
          await res.body?.cancel();
          clientSignal.removeEventListener('abort', onClientAbort);
          pool.release(candidate, 'failed');
          upstream = undefined;
          continue;
        }
        lastResponse = res;
        break;
      } catch {
        clientSignal.removeEventListener('abort', onClientAbort);
        pool.release(candidate, clientSignal.aborted ? 'neutral' : 'failed');
        upstream = undefined;
        if (clientSignal.aborted) break;
      }
    }

    const logDone = (status: number, tokens?: number, estimated?: boolean) =>
      log.info('gw_request', { ...who, path, model, ...(servedAs ? { servedAs } : {}), status, ms: Date.now() - started, upstream: upstream?.id, attempts: tried.size, tokens, estimated });

    if (!lastResponse || !upstream) {
      admission.release();
      if (clientSignal.aborted) {
        logDone(499);
        return c.body(null, 499 as 400);
      }
      const anyHealthy = pool.upstreams.some((u) => (route.kind === 'any' || u.kind === route.kind) && pool.admits(u));
      logDone(503);
      return anyHealthy
        ? fail(c, 503, 'busy', 'all model workers are busy, retry shortly', 2)
        : fail(c, 503, 'unavailable', 'no healthy model worker', 5);
    }

    const res = lastResponse;
    const served = upstream;
    served.served++;
    const headers = new Headers({ 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    const type = res.headers.get('content-type');
    if (type) headers.set('content-type', type);

    if (route.list) {
      // Listing responses are tiny; filter them to the allowlist so callers see only what they may use.
      const status = res.status;
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
        if (route.list === 'ollama' && Array.isArray(json.models)) json.models = withAliases(json.models as Array<{ name?: string }>, 'name');
        if (route.list === 'openai' && Array.isArray(json.data)) json.data = withAliases(json.data as Array<{ id?: string }>, 'id');
      } catch {
        json = {};
      }
      pool.release(served, status < 500 ? 'ok' : 'failed');
      admission.release();
      logDone(status);
      return c.json(json, status as 200);
    }

    // Stream through chunk by chunk (pull = backpressure); settle accounting exactly once.
    const meter = new UsageMeter(body?.byteLength ?? 0);
    const reader = res.body?.getReader();
    let settled = false;
    const settle = (outcome: 'ok' | 'failed' | 'neutral') => {
      if (settled) return;
      settled = true;
      const usage = meter.result();
      pool.release(served, res.status >= 500 ? 'failed' : outcome);
      admission.release();
      limits.record(who.sub, usage.tokens);
      logDone(outcome === 'neutral' ? 499 : res.status, usage.tokens, usage.estimated);
    };
    if (!reader) {
      settle('ok');
      return new Response(null, { status: res.status, headers });
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            settle('ok');
            controller.close();
            return;
          }
          meter.push(value);
          controller.enqueue(value);
        } catch (error) {
          settle(clientSignal.aborted || abort.signal.aborted ? 'neutral' : 'failed');
          controller.error(error);
        }
      },
      cancel() {
        settle('neutral');
        abort.abort();
        void reader.cancel().catch(() => {});
      },
    });
    return new Response(stream, { status: res.status, headers });
  });

  return app;
}
