/**
 * `pnpm store:check`: is the object store configured, and can the engine's credentials reach
 * the bucket? Read-only: a bucket HEAD and one list page. Never prints the secret key.
 */
import { parseObjectStoreConfig } from '../config';
import { createObjectStore, VAULTS_PREFIX } from './index';

async function main(): Promise<number> {
  const config = parseObjectStoreConfig();
  const store = createObjectStore(config);
  if (!config || !store) {
    console.log('store: not configured (set OBJECT_STORE_ENDPOINT and OBJECT_STORE_BUCKET; see docs/object-store.md)');
    return 0;
  }
  console.log(`store: configured — ${config.endpoint} bucket=${config.bucket} region=${config.region} pathStyle=${config.forcePathStyle} key=${config.accessKeyId}`);
  const started = Date.now();
  try {
    await store.ping();
    const page = await store.list(VAULTS_PREFIX, { limit: 1 });
    console.log(`store: reachable in ${Date.now() - started}ms (${page.items.length ? 'vaults present' : 'no vaults yet'})`);
    return 0;
  } catch (error) {
    console.error(`store: unreachable — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`store: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
