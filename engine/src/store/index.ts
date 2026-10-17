import type { ObjectStoreConfig } from '../config';
import type { ObjectStore } from './object-store';
import { S3ObjectStore } from './s3-store';

export * from './keys';
export * from './object-store';
export { MemoryObjectStore } from './memory-store';
export { S3ObjectStore } from './s3-store';

/** The configured store, or null when object storage is off (the default). */
export function createObjectStore(config: ObjectStoreConfig | null): ObjectStore | null {
  return config ? new S3ObjectStore(config) : null;
}
