import { parseArgs } from 'node:util';
import { mintToken } from '../tokens';

/**
 * Local helper: `pnpm --filter @sef/gateway token -- --sub ananya [--vm m_x] [--ttl 3600]`.
 * The orchestrator (PR-42) calls mintToken in-process with the same secret instead.
 */
const { values } = parseArgs({ options: { sub: { type: 'string' }, vm: { type: 'string' }, ttl: { type: 'string', default: '3600' } } });
const secret = process.env.GATEWAY_TOKEN_SECRET;
if (!secret || !values.sub) {
  console.error('usage: GATEWAY_TOKEN_SECRET=... token --sub <accountId> [--vm <machineId>] [--ttl <seconds>]');
  process.exit(1);
}
console.log(mintToken(secret, { sub: values.sub, vm: values.vm, ttlSeconds: Number(values.ttl) }));
