/**
 * The narrow object-store surface vault sync needs (docs/object-store.md). Bodies are whole
 * buffers for now: vault pages are small, and streaming large media is a follow-up.
 */
export type ObjectBody = Uint8Array | string;

export interface PutOptions {
  contentType?: string;
  /** `'*'`: create only. The put fails with PreconditionFailedError if the key already exists. */
  ifNoneMatch?: '*';
}

export interface ObjectInfo {
  key: string;
  size: number;
  /** Unquoted ETag. For single-part uploads this is the body's MD5 hex on S3, MinIO and Spaces. */
  etag: string;
  lastModified?: Date;
  contentType?: string;
}

export interface StoredObject extends ObjectInfo {
  body: Uint8Array;
}

export interface ListOptions {
  /** Opaque cursor from a previous page. */
  cursor?: string;
  /** Page size, 1–1000 (S3's ceiling). Defaults to 1000. */
  limit?: number;
}

export interface ListPage {
  items: ObjectInfo[];
  /** Present when more results exist; pass it back as `cursor`. */
  cursor?: string;
}

export interface ObjectStore {
  put(key: string, body: ObjectBody, options?: PutOptions): Promise<{ etag: string }>;
  /** The object, or null when the key does not exist. A missing bucket throws, never reads as empty. */
  get(key: string): Promise<StoredObject | null>;
  /** Metadata, or null. A HEAD 404 carries no body, so call ping() first to rule out a missing bucket. */
  head(key: string): Promise<ObjectInfo | null>;
  /** One page of keys under `prefix`, in lexicographic key order. */
  list(prefix: string, options?: ListOptions): Promise<ListPage>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Throws unless the bucket is reachable with the configured credentials. */
  ping(): Promise<void>;
}

export class ObjectStoreError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

/** A conditional write lost: the key already exists (ifNoneMatch) or changed concurrently. */
export class PreconditionFailedError extends ObjectStoreError {
  constructor(key: string, status?: number, code?: string) {
    super(`Precondition failed for ${key}`, status, code);
    this.name = 'PreconditionFailedError';
  }
}

export const MAX_LIST_LIMIT = 1000;

export function listLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`list limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

/**
 * Store-level guard for any key, whatever built it. URL resolution collapses `.`/`..` segments,
 * so such a key could address a different object than the one named; empty segments are refused
 * for the same reason. Vault keys get stricter checks in keys.ts.
 */
export function assertObjectKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key, 'utf8') > 1024) {
    throw new ObjectStoreError('Object key must be 1–1024 bytes');
  }
  if (key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ObjectStoreError('Object key must not contain empty, . or .. segments');
  }
  return key;
}

export function toBytes(body: ObjectBody): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}
