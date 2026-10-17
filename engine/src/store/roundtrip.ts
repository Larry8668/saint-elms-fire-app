/**
 * `pnpm --filter @sef/engine store:roundtrip`: a write check of the configured object store,
 * for an endpoint the engine reaches through a proxy or tunnel (docs/demo-hosted.md). It signs
 * real requests exactly as vault sync does and runs, under a throwaway `vaults/<account>/`
 * prefix: a create-only put, a get, a compare-and-swap put, a stale swap that must be refused,
 * a 2 MiB binary put/get, a list, and deletes. Prints timings, never the secret key. Exit 1 on
 * any mismatch.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseObjectStoreConfig } from '../config';
import { createObjectStore, PreconditionFailedError, vaultKey } from './index';

async function main(): Promise<number> {
  const config = parseObjectStoreConfig();
  const store = createObjectStore(config);
  if (!config || !store) {
    console.error('roundtrip: the object store is not configured (OBJECT_STORE_*)');
    return 1;
  }
  const account = `roundtrip-${randomUUID().slice(0, 8)}`;
  const text = vaultKey(account, 'brain/check.md');
  const blob = vaultKey(account, 'brain/raw/check.bin');
  const timings: string[] = [];
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const value = await run();
    timings.push(`${name} ${Date.now() - started}ms`);
    return value;
  };
  const fail = (message: string) => {
    throw new Error(message);
  };
  try {
    await step('ping', () => store.ping());
    const first = await step('put(create-only)', () => store.put(text, '# check\n', { ifNoneMatch: '*', contentType: 'text/markdown' }));
    const got = await step('get', () => store.get(text));
    if (!got || Buffer.from(got.body).toString('utf8') !== '# check\n') fail('get returned different bytes');
    await step('put(create-only, exists)', () =>
      store.put(text, 'x', { ifNoneMatch: '*' }).then(
        () => fail('a create-only put over an existing key was accepted (If-None-Match ignored)'),
        (error) => (error instanceof PreconditionFailedError ? undefined : Promise.reject(error)),
      ),
    );
    await step('put(if-match)', () => store.put(text, '# check 2\n', { ifMatch: first.etag }));
    await step('put(stale if-match)', () =>
      store.put(text, 'stale', { ifMatch: first.etag }).then(
        () => fail('a stale compare-and-swap was accepted (If-Match ignored)'),
        (error) => (error instanceof PreconditionFailedError ? undefined : Promise.reject(error)),
      ),
    );
    const bytes = randomBytes(2 * 1024 * 1024);
    await step('put(2 MiB)', () => store.put(blob, bytes, { contentType: 'application/octet-stream' }));
    const back = await step('get(2 MiB)', () => store.get(blob));
    if (!back || !Buffer.from(back.body).equals(bytes)) fail('the 2 MiB object came back different');
    const page = await step('list', () => store.list(`vaults/${account}/`));
    if (page.items.length !== 2) fail(`list returned ${page.items.length} keys, expected 2`);
    console.log(`roundtrip: ok via ${config.endpoint} (pathStyle=${config.forcePathStyle}) — ${timings.join(', ')}`);
    return 0;
  } catch (error) {
    console.error(`roundtrip: FAILED via ${config.endpoint} — ${error instanceof Error ? error.message : String(error)} (after ${timings.join(', ') || 'nothing'})`);
    return 1;
  } finally {
    await Promise.allSettled([store.delete(text), store.delete(blob)]);
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`roundtrip: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
