import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeedRefusal, fetchFeed } from './fetch';
import { fakeFetch, RSS, xml } from './testing/fixtures';

const allowed = new Set(['www.nasa.gov']);

test('a host outside the consented set is refused without any request', async () => {
  const fake = fakeFetch(() => xml(RSS));
  await assert.rejects(fetchFeed({ url: 'https://evil.example/feed', allowedHosts: allowed }, fake.fetchImpl), (e) => e instanceof FeedRefusal && e.code === 'host_not_allowed');
  await assert.rejects(fetchFeed({ url: 'http://www.nasa.gov/feed', allowedHosts: allowed }, fake.fetchImpl), (e) => e instanceof FeedRefusal && e.code === 'not_https');
  assert.equal(fake.calls.length, 0);
});

test('a redirect to a foreign host is refused at the hop', async () => {
  const fake = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://tracker.example/x' } }));
  await assert.rejects(fetchFeed({ url: 'https://www.nasa.gov/feed', allowedHosts: allowed }, fake.fetchImpl), (e) => e instanceof FeedRefusal && e.code === 'host_not_allowed');
  assert.equal(fake.calls.length, 1);
});

test('same-host redirects are followed; validators are sent and a 304 is honoured', async () => {
  let n = 0;
  const fake = fakeFetch(() => (n++ === 0 ? new Response(null, { status: 301, headers: { location: '/rss' } }) : new Response(null, { status: 304 })));
  const out = await fetchFeed({ url: 'https://www.nasa.gov/feed', allowedHosts: allowed, etag: '"v1"', lastModified: 'Thu, 15 Oct 2026 00:00:00 GMT' }, fake.fetchImpl);
  assert.deepEqual(out, { status: 'not_modified' });
  assert.equal(fake.calls[1]!.url, 'https://www.nasa.gov/rss');
  assert.equal(fake.calls[1]!.headers['if-none-match'], '"v1"');
  assert.equal(fake.calls[1]!.headers['if-modified-since'], 'Thu, 15 Oct 2026 00:00:00 GMT');
});

test('a full response returns parsed items and new validators; oversize bodies are refused', async () => {
  const ok = await fetchFeed({ url: 'https://www.nasa.gov/feed', allowedHosts: allowed }, fakeFetch(() => xml(RSS, { etag: '"v2"' })).fetchImpl);
  assert.ok(ok.status === 'ok' && ok.items.length === 3 && ok.etag === '"v2"');
  const big = fakeFetch(() => xml('x', { 'content-length': String(5_000_000) }));
  await assert.rejects(fetchFeed({ url: 'https://www.nasa.gov/feed', allowedHosts: allowed }, big.fetchImpl), (e) => e instanceof FeedRefusal && e.code === 'too_large');
});
