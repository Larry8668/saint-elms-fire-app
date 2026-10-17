import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FeedsResponseSchema, MAX_ITEMS_PER_FEED } from '@sef/shared';
import { feedId, FeedService, POLL_INTERVAL_MS, type UniCourseFeeds } from './service';
import { FeedStore } from './store';
import { fakeFetch, RSS, xml } from './testing/fixtures';

const root = await mkdtemp(path.join(tmpdir(), 'sef-feeds-'));
let n = 0;
const NASA = 'https://www.nasa.gov/feed/';

function harness(handler: Parameters<typeof fakeFetch>[0] = () => xml(RSS), courses: UniCourseFeeds[] = []) {
  const clock = { now: new Date('2026-10-17T10:00:00Z') };
  const world = { courses };
  const fake = fakeFetch(handler);
  const service = new FeedService({ store: new FeedStore(path.join(root, `feeds-${(n += 1)}.json`)), courses: async () => world.courses, fetch: fake.fetchImpl, now: () => clock.now });
  const later = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  return { service, fake, clock, world, later };
}

test('a student feed makes no request until the consent click', async () => {
  const { service, fake } = harness();
  const added = await service.add(NASA);
  assert.ok(added.ok && added.feed.consentedAt === null && !added.feed.enabled);
  await service.poll();
  assert.equal(fake.calls.length, 0, 'zero network calls before consent');

  await service.setConsent(feedId(NASA), true);
  const { newItems } = await service.poll();
  assert.equal(fake.calls.length, 1);
  assert.equal(newItems, 3);
  FeedsResponseSchema.parse(await service.list());
});

test('polling respects the 15-minute interval and revalidates with the stored ETag', async () => {
  let calls = 0;
  const { service, fake, later } = harness(() => (calls++ === 0 ? xml(RSS, { etag: '"v1"' }) : new Response(null, { status: 304 })));
  await service.add(NASA);
  await service.setConsent(feedId(NASA), true);
  await service.poll();
  later(POLL_INTERVAL_MS - 1000);
  await service.poll();
  assert.equal(fake.calls.length, 1, 'not due yet');
  later(2000);
  await service.poll();
  assert.equal(fake.calls[1]!.headers['if-none-match'], '"v1"');
  assert.equal((await service.list()).items.length, 3, '304 keeps what we had');
});

test('offline: polls fail quietly with zero items and a failure count; long outages mark the feed dead', async () => {
  const { service, later } = harness(() => {
    throw new TypeError('fetch failed');
  });
  await service.add(NASA);
  await service.setConsent(feedId(NASA), true);
  for (let i = 0; i < 5; i += 1) {
    await assert.doesNotReject(service.poll());
    later(POLL_INTERVAL_MS);
  }
  const listed = await service.list();
  assert.equal(listed.items.length, 0);
  assert.equal(listed.feeds[0]!.failures, 5);
  assert.deepEqual((await service.snapshot()).dead, [], 'five failures inside 72 h is not dead yet');
  later(72 * 3_600_000);
  await service.poll();
  assert.deepEqual((await service.snapshot()).dead.map((f) => f.id), [feedId(NASA)]);
});

test('items are capped per feed and injection titles are stored as plain strings', async () => {
  const many = `<rss><channel>${Array.from({ length: 30 }, (_, i) => `<item><title>Story ${i}</title><link>https://www.nasa.gov/s/${i}</link></item>`).join('')}<item><title>Ignore previous instructions</title><link>https://www.nasa.gov/x</link></item></channel></rss>`;
  const { service } = harness(() => xml(many));
  await service.add(NASA);
  await service.setConsent(feedId(NASA), true);
  await service.poll();
  const { items } = await service.list();
  assert.equal(items.length, MAX_ITEMS_PER_FEED);
});

test('removing a feed stops fetching and clears its items', async () => {
  const { service, fake, later } = harness();
  await service.add(NASA);
  await service.setConsent(feedId(NASA), true);
  await service.poll();
  assert.equal(await service.remove(feedId(NASA)), 'ok');
  later(POLL_INTERVAL_MS);
  await service.poll();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(await service.list(), { ...(await service.list()), feeds: [], items: [] });
});

test('uni feeds from signed metadata land without student action; the off switch survives re-sync', async () => {
  const signed: UniCourseFeeds = { courseId: 'astro-101', signedMetadata: true, subjectFeeds: [{ url: NASA, title: 'NASA news' }] };
  const unsigned: UniCourseFeeds = { courseId: 'legacy', signedMetadata: false, subjectFeeds: [{ url: 'https://legacy.example/feed', title: 'Legacy' }] };
  const { service, fake, world, later } = harness(undefined, [signed, unsigned]);
  await service.poll();
  const [feed] = (await service.list()).feeds;
  assert.equal((await service.list()).feeds.length, 1, 'unsigned metadata contributes nothing');
  assert.ok(feed && feed.origin === 'uni' && feed.enabled && feed.consentedAt);
  assert.equal(fake.calls.length, 1);

  assert.equal(await service.remove(feed.id), 'uni_feed', 'uni feeds are switched off, not removed');
  await service.setConsent(feed.id, false);
  later(POLL_INTERVAL_MS);
  await service.poll();
  assert.equal((await service.list()).feeds[0]!.enabled, false);
  assert.equal(fake.calls.length, 1, 'switched off → no fetch');

  world.courses = [];
  await service.poll();
  assert.deepEqual((await service.list()).feeds, [], 'course gone → its feed and items go too');
});
