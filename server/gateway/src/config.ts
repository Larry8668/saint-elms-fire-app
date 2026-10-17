import { envInt, envPort, parseGatewayDevTokens, type GatewayDevToken } from '@sef/shared/node';

export type UpstreamKind = 'ollama' | 'vllm';

export interface UpstreamSpec {
  /** Base URL without a trailing slash, e.g. http://gpu-1:11434. */
  url: string;
  kind: UpstreamKind;
  maxInFlight: number;
}

export interface GatewayConfig {
  port: number;
  host: string;
  tokenSecret?: string;
  devTokens: GatewayDevToken[];
  metricsToken?: string;
  upstreams: UpstreamSpec[];
  /** Optional bearer sent to every upstream (a RunPod/vLLM worker started with --api-key). */
  upstreamToken?: string;
  /** Model names callers may use; `name` also matches `name:latest`. */
  models: string[];
  maxBodyBytes: number;
  queueTimeoutMs: number;
  healthIntervalMs: number;
  failureThreshold: number;
  cooldownMs: number;
  ratePerMinute: number;
  maxConcurrentPerSubject: number;
  dailyTokenBudget: number;
}

const text = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || undefined;

/**
 * `GATEWAY_UPSTREAMS=http://gpu-1:11434,vllm:http://gpu-2:8000#max=16`
 * An optional `vllm:` prefix marks an OpenAI-only worker (no Ollama native API);
 * `#max=N` overrides the per-upstream concurrency limit. The fragment is never sent.
 */
export function parseUpstreams(raw: string, defaultMax: number): UpstreamSpec[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const kind: UpstreamKind = entry.startsWith('vllm:') ? 'vllm' : 'ollama';
      const url = new URL(kind === 'vllm' ? entry.slice(5) : entry);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`GATEWAY_UPSTREAMS: ${entry} is not http(s)`);
      const max = /^#max=(\d+)$/.exec(url.hash)?.[1];
      url.hash = '';
      return { url: url.toString().replace(/\/+$/, ''), kind, maxInFlight: max ? Math.max(1, Number(max)) : defaultMax };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const tokenSecret = text(env, 'GATEWAY_TOKEN_SECRET');
  if (tokenSecret && tokenSecret.length < 32) throw new Error('GATEWAY_TOKEN_SECRET must be at least 32 characters');
  const devTokens = parseGatewayDevTokens(env.GATEWAY_DEV_TOKENS);
  if (!tokenSecret && !devTokens.length) throw new Error('Set GATEWAY_TOKEN_SECRET and/or GATEWAY_DEV_TOKENS: the gateway never runs open');
  const upstreams = parseUpstreams(text(env, 'GATEWAY_UPSTREAMS') ?? 'http://127.0.0.1:11434', envInt('GATEWAY_UPSTREAM_MAX_INFLIGHT', 4, {}, env));
  if (!upstreams.length) throw new Error('GATEWAY_UPSTREAMS lists no upstream');
  return {
    port: envPort('GATEWAY_PORT', 4300, env),
    host: text(env, 'GATEWAY_HOST') ?? '127.0.0.1',
    tokenSecret,
    devTokens,
    metricsToken: text(env, 'GATEWAY_METRICS_TOKEN'),
    upstreams,
    upstreamToken: text(env, 'GATEWAY_UPSTREAM_TOKEN'),
    models: (text(env, 'GATEWAY_MODELS') ?? 'gemma4:e4b,gemma4:e2b,embeddinggemma,shieldgemma:2b')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    maxBodyBytes: envInt('GATEWAY_MAX_BODY_BYTES', 32 * 1024 * 1024, {}, env),
    queueTimeoutMs: envInt('GATEWAY_QUEUE_TIMEOUT_MS', 30_000, { min: 0 }, env),
    healthIntervalMs: envInt('GATEWAY_HEALTH_INTERVAL_MS', 10_000, {}, env),
    failureThreshold: envInt('GATEWAY_FAILURE_THRESHOLD', 3, {}, env),
    cooldownMs: envInt('GATEWAY_COOLDOWN_MS', 15_000, {}, env),
    ratePerMinute: envInt('GATEWAY_RATE_PER_MINUTE', 60, {}, env),
    maxConcurrentPerSubject: envInt('GATEWAY_MAX_CONCURRENT_PER_SUBJECT', 4, {}, env),
    dailyTokenBudget: envInt('GATEWAY_DAILY_TOKEN_BUDGET', 300_000, {}, env),
  };
}
