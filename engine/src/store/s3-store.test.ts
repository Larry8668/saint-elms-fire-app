import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ObjectStoreError, PreconditionFailedError } from './object-store';
import { S3ObjectStore } from './s3-store';

// A scripted stand-in for S3: enough to pin URL building, error mapping and ListObjectsV2 parsing.
let handle: (req: IncomingMessage, res: ServerResponse) => void = () => {};
const seen: string[] = [];
const server = createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  handle(req, res);
});
let store: S3ObjectStore;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  store = new S3ObjectStore({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    bucket: 'sef-vaults',
    accessKeyId: 'k',
    secretAccessKey: 's',
    forcePathStyle: true,
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const xmlError = (status: number, code: string) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
};

test('a missing key reads as null, but a missing bucket throws instead of looking empty', async () => {
  handle = xmlError(404, 'NoSuchKey');
  assert.equal(await store.get('vaults/a/files/x.md'), null);
  handle = xmlError(404, 'NoSuchBucket');
  await assert.rejects(store.get('vaults/a/files/x.md'), (error: ObjectStoreError) => error.code === 'NoSuchBucket');
});

test('keys are path-style and percent-encoded per segment; 412 maps to PreconditionFailedError', async () => {
  seen.length = 0;
  handle = xmlError(412, 'PreconditionFailed');
  await assert.rejects(store.put('vaults/a/files/raw/a b+c#d?.md', 'x', { ifNoneMatch: '*' }), PreconditionFailedError);
  assert.deepEqual(seen, ['PUT /sef-vaults/vaults/a/files/raw/a%20b%2Bc%23d%3F.md']);
});

test('list decodes url-encoded keys and XML entities, and returns the continuation cursor', async () => {
  handle = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>vaults/a/files/caf%C3%A9+%26+t%C3%A9.md</Key><Size>12</Size><ETag>&quot;abc&quot;</ETag><LastModified>2026-10-17T10:00:00.000Z</LastModified></Contents>
      <NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`);
  };
  const page = await store.list('vaults/a/', { limit: 1 });
  assert.equal(page.cursor, 'tok&1');
  assert.deepEqual(page.items, [{ key: 'vaults/a/files/café & té.md', size: 12, etag: 'abc', lastModified: new Date('2026-10-17T10:00:00.000Z') }]);
  assert.ok(seen.at(-1)?.includes('encoding-type=url') && seen.at(-1)?.includes('max-keys=1'));
});

test('ifMatch sends a quoted If-Match, and a 404 under it is a lost compare-and-swap', async () => {
  let ifMatch: string | undefined;
  handle = (req, res) => {
    ifMatch = req.headers['if-match'] as string | undefined;
    xmlError(404, 'NoSuchKey')(req, res);
  };
  await assert.rejects(store.put('vaults/a/manifest.json', '{}', { ifMatch: 'abc123' }), PreconditionFailedError);
  assert.equal(ifMatch, '"abc123"');
  handle = xmlError(404, 'NoSuchKey');
  await assert.rejects(store.put('vaults/a/manifest.json', '{}'), (error: ObjectStoreError) => !(error instanceof PreconditionFailedError) && error.status === 404);
});
