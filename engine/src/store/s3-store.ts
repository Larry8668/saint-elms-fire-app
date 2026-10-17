import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { ObjectStoreConfig } from '../config';
import {
  assertObjectKey,
  listLimit,
  type ListOptions,
  type ListPage,
  type ObjectBody,
  type ObjectInfo,
  type ObjectStore,
  ObjectStoreError,
  PreconditionFailedError,
  type PutOptions,
  type StoredObject,
  toBytes,
} from './object-store';

const DEFAULT_TIMEOUT_MS = 30_000;

const unquote = (etag: string | null) => (etag ?? '').replace(/^(W\/)?"|"$/g, '');

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? whole;
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}
function xmlField(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? xmlText(match[1]) : undefined;
}
/** `encoding-type=url` keys: percent-encoded, with `+` for space. */
const decodeListedKey = (raw: string) => decodeURIComponent(raw.replace(/\+/g, ' '));

/** Any S3-compatible endpoint (MinIO, DigitalOcean Spaces, AWS) over fetch with SigV4 signing. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: AwsClient;
  private readonly base: URL;

  constructor(
    private readonly config: ObjectStoreConfig,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
      // aws4fetch defaults to 10 retries; sync has its own retry loop, so fail fast here.
      retries: 2,
    });
    const endpoint = new URL(config.endpoint);
    this.base = config.forcePathStyle
      ? new URL(`${endpoint.origin}/${encodeURIComponent(config.bucket)}/`)
      : new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}/`);
  }

  private url(key: string | null, query?: Record<string, string>): string {
    const path = key === null ? '' : assertObjectKey(key).split('/').map(encodeURIComponent).join('/');
    const url = new URL(path, this.base);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url.toString();
  }

  private async send(method: string, url: string, init: { headers?: Record<string, string>; body?: Uint8Array } = {}) {
    try {
      return await this.client.fetch(url, {
        method,
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ObjectStoreError(`Object store ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async failure(response: Response, what: string): Promise<ObjectStoreError> {
    const text = await response.text().catch(() => '');
    const code = xmlField(text, 'Code');
    return new ObjectStoreError(`Object store ${what} failed: HTTP ${response.status}${code ? ` ${code}` : ''}`, response.status, code);
  }

  private info(key: string, response: Response): ObjectInfo {
    const modified = response.headers.get('last-modified');
    return {
      key,
      size: Number(response.headers.get('content-length') ?? 0),
      etag: unquote(response.headers.get('etag')),
      lastModified: modified ? new Date(modified) : undefined,
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }

  async put(key: string, body: ObjectBody, options: PutOptions = {}): Promise<{ etag: string }> {
    const bytes = toBytes(body);
    const headers: Record<string, string> = {
      // Signing the real payload hash lets the server reject a body corrupted in transit.
      'x-amz-content-sha256': createHash('sha256').update(bytes).digest('hex'),
      'content-type': options.contentType ?? 'application/octet-stream',
    };
    if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch;
    if (options.ifMatch) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await this.send('PUT', this.url(key), { headers, body: bytes });
    // 409 ConditionalRequestConflict: a concurrent conditional write to the same key won.
    // A missing key under If-Match is 404 NoSuchKey on S3/MinIO: the expected version is gone too.
    const conditional = Boolean(options.ifNoneMatch || options.ifMatch);
    if (response.status === 412 || (conditional && response.status === 409) || (options.ifMatch && response.status === 404)) {
      await response.body?.cancel();
      throw new PreconditionFailedError(key, response.status);
    }
    if (!response.ok) throw await this.failure(response, `PUT ${key}`);
    await response.body?.cancel();
    return { etag: unquote(response.headers.get('etag')) };
  }

  async get(key: string): Promise<StoredObject | null> {
    const response = await this.send('GET', this.url(key));
    if (response.status === 404) {
      // A missing bucket must never read as an empty vault: a restore would start from nothing.
      const failure = await this.failure(response, `GET ${key}`);
      if (failure.code === 'NoSuchBucket') throw failure;
      return null;
    }
    if (!response.ok) throw await this.failure(response, `GET ${key}`);
    const body = new Uint8Array(await response.arrayBuffer());
    return { ...this.info(key, response), size: body.byteLength, body };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const response = await this.send('HEAD', this.url(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new ObjectStoreError(`Object store HEAD ${key} failed: HTTP ${response.status}`, response.status);
    return this.info(key, response);
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    const query: Record<string, string> = {
      'list-type': '2',
      prefix,
      'max-keys': String(listLimit(options.limit)),
      'encoding-type': 'url',
    };
    if (options.cursor) query['continuation-token'] = options.cursor;
    const response = await this.send('GET', this.url(null, query));
    if (!response.ok) throw await this.failure(response, `LIST ${prefix}`);
    const xml = await response.text();
    const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, entry]): ObjectInfo => {
      const modified = xmlField(entry, 'LastModified');
      return {
        key: decodeListedKey(xmlField(entry, 'Key') ?? ''),
        size: Number(xmlField(entry, 'Size') ?? 0),
        etag: unquote(xmlField(entry, 'ETag') ?? ''),
        lastModified: modified ? new Date(modified) : undefined,
      };
    });
    const cursor = xmlField(xml, 'IsTruncated') === 'true' ? xmlField(xml, 'NextContinuationToken') : undefined;
    return cursor ? { items, cursor } : { items };
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', this.url(key));
    if (!response.ok && response.status !== 404) throw await this.failure(response, `DELETE ${key}`);
    await response.body?.cancel();
  }

  async ping(): Promise<void> {
    const response = await this.send('HEAD', this.base.toString());
    if (response.ok) return;
    const reason = response.status === 404 ? 'bucket does not exist' : response.status === 403 ? 'access denied' : `HTTP ${response.status}`;
    throw new ObjectStoreError(`Bucket ${this.config.bucket} is not reachable: ${reason}`, response.status);
  }
}
