import { createHash } from 'node:crypto';
import {
  assertObjectKey,
  listLimit,
  type ListOptions,
  type ListPage,
  type ObjectBody,
  type ObjectInfo,
  type ObjectStore,
  PreconditionFailedError,
  type PutOptions,
  type StoredObject,
  toBytes,
} from './object-store';

interface Entry {
  body: Uint8Array;
  info: ObjectInfo;
}

/** An in-process ObjectStore with S3 semantics (MD5 ETags, ordered pages) for unit tests. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Entry>();

  async put(key: string, body: ObjectBody, options: PutOptions = {}): Promise<{ etag: string }> {
    assertObjectKey(key);
    if (options.ifNoneMatch === '*' && this.objects.has(key)) throw new PreconditionFailedError(key, 412);
    if (options.ifMatch !== undefined && this.objects.get(key)?.info.etag !== options.ifMatch) throw new PreconditionFailedError(key, 412);
    const bytes = Uint8Array.from(toBytes(body));
    const etag = createHash('md5').update(bytes).digest('hex');
    this.objects.set(key, {
      body: bytes,
      info: { key, size: bytes.byteLength, etag, lastModified: new Date(), contentType: options.contentType },
    });
    return { etag };
  }

  async get(key: string): Promise<StoredObject | null> {
    const entry = this.objects.get(assertObjectKey(key));
    return entry ? { ...entry.info, body: Uint8Array.from(entry.body) } : null;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const entry = this.objects.get(assertObjectKey(key));
    return entry ? { ...entry.info } : null;
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    const limit = listLimit(options.limit);
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix) && (!options.cursor || key > options.cursor)).sort();
    const page = keys.slice(0, limit);
    const items = page.map((key) => ({ ...this.objects.get(key)!.info }));
    return keys.length > limit ? { items, cursor: page[page.length - 1] } : { items };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(assertObjectKey(key));
  }

  async ping(): Promise<void> {}
}
