/**
 * The ObjectStore contract against a real S3-compatible server. Skipped unless
 * OBJECT_STORE_TEST_ENDPOINT is set — see docs/object-store.md for a one-line MinIO to run it on.
 * Uses its own OBJECT_STORE_TEST_* variables so it can never touch a configured dev store.
 */
import { S3ObjectStore } from './s3-store';
import { objectStoreContract } from './store-contract';

const endpoint = process.env.OBJECT_STORE_TEST_ENDPOINT?.trim();

objectStoreContract(
  's3 store (live)',
  () =>
    new S3ObjectStore({
      endpoint: endpoint!,
      region: process.env.OBJECT_STORE_TEST_REGION ?? 'us-east-1',
      bucket: process.env.OBJECT_STORE_TEST_BUCKET ?? 'sef-vaults-test',
      accessKeyId: process.env.OBJECT_STORE_TEST_ACCESS_KEY ?? '',
      secretAccessKey: process.env.OBJECT_STORE_TEST_SECRET_KEY ?? '',
      forcePathStyle: process.env.OBJECT_STORE_TEST_FORCE_PATH_STYLE !== 'false',
    }),
  { skip: endpoint ? false : 'OBJECT_STORE_TEST_ENDPOINT is not set' },
);
