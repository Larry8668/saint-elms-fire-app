import { parseArgs } from 'node:util';
import { mintGatewayToken } from '@sef/shared/node';

/**
 * Local helper: `pnpm --filter @sef/gateway token -- --sub ananya [--vm m_x] [--ttl 3600]`.
 * The orchestrator (PR-42) calls mintGatewayToken in-process with the same secret instead.
 */
const { values } = parseArgs({ options: { sub: { type: 'string' }, vm: { type: 'string' }, ttl: { type: 'string', default: '3600' } } });
const secret = process.env.GATEWAY_TOKEN_SECRET;
if (!secret || !values.sub) {
  console.error('usage: GATEWAY_TOKEN_SECRET=... token --sub <accountId> [--vm <machineId>] [--ttl <seconds>]');
  process.exit(1);
}
console.log(mintGatewayToken(secret, { sub: values.sub, vm: values.vm, ttlSeconds: Number(values.ttl) }));
