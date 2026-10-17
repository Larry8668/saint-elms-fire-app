import { serve } from '@hono/node-server';
import { createLogger, errorFields } from '@sef/shared';
import { createGatewayApp } from './app';
import { loadConfig } from './config';
import { SubjectLimits } from './limits';
import { startHealthChecks, UpstreamPool } from './pool';

const log = createLogger('gateway', process.env.LOG_LEVEL === 'debug');

try {
  const config = loadConfig();
  const pool = new UpstreamPool(config.upstreams, { failureThreshold: config.failureThreshold, cooldownMs: config.cooldownMs });
  const limits = new SubjectLimits({
    ratePerMinute: config.ratePerMinute,
    maxConcurrent: config.maxConcurrentPerSubject,
    dailyTokenBudget: config.dailyTokenBudget,
  });
  if (config.devTokens.length && process.env.NODE_ENV === 'production') log.warn('gateway_dev_tokens_enabled', { count: config.devTokens.length });
  startHealthChecks(pool, config.healthIntervalMs, config.upstreamToken);
  const app = createGatewayApp({ config, pool, limits, log });
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('gateway_listening', {
      url: `http://${config.host}:${info.port}`,
      upstreams: pool.snapshot().map((u) => ({ id: u.id, kind: u.kind, maxInFlight: u.maxInFlight })),
      models: config.models,
      signedTokens: Boolean(config.tokenSecret),
      devTokens: config.devTokens.length,
    });
  });
} catch (error) {
  log.error('gateway_boot_failed', errorFields(error));
  process.exit(1);
}
