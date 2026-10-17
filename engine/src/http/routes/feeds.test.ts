import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FeedsResponseSchema, type Feed } from '@sef/shared';
import { FeedService } from '../../feeds/service';
import { FeedStore } from '../../feeds/store';
import { feedRoutes } from './feeds';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-feed-route-'));
const profileA = { id: 'student-a', name: 'A', email: 'a@example.test', cohortId: 'c-1', offlineReady: true, admission: 'approved' };
const profileB = { ...profileA, id: 'student-b', email: 'b@example.test' };
const service = (id: string) => new FeedService({ store: new FeedStore(path.join(dir, `${id}.json`)), courses: async () => [], fetch: async () => new Response('') });
const workspaces = new Map([
  [profileA.id, { profile: profileA, feeds: service(profileA.id) }],
  [profileB.id, { profile: profileB, feeds: service(profileB.id) }],
]);
const deps = {
  auth: { resolve: async (token: string) => (workspaces.has(token) ? { profile: workspaces.get(token)!.profile, mode: 'offline' as const } : null) },
  workspaces: { get: async (profile: typeof profileA) => workspaces.get(profile.id) },
};
const app = feedRoutes(deps as never);
const as = (id: string) => ({ authorization: `Bearer ${id}`, 'content-type': 'application/json' });
const post = (url: string, id: string, body: unknown) => app.request(url, { method: 'POST', headers: as(id), body: JSON.stringify(body) });

test('feed routes sit behind the profile session', async () => {
  assert.equal((await app.request('/feeds')).status, 401);
  assert.equal((await app.request('/feeds', { method: 'POST', body: '{}' })).status, 401);
});

test('add → consent → remove, scoped to the caller; http and junk URLs are refused', async () => {
  assert.equal((await post('/feeds', 'student-a', { url: 'http://insecure.example/feed' })).status, 400);
  assert.equal((await post('/feeds', 'student-a', { url: 'javascript:alert(1)' })).status, 400);

  const created = await post('/feeds', 'student-a', { url: 'https://www.nasa.gov/feed/', title: 'NASA' });
  assert.equal(created.status, 201);
  const feed = (await created.json()) as Feed;
  assert.equal(feed.consentedAt, null);
  assert.equal((await post('/feeds', 'student-a', { url: 'https://www.nasa.gov/feed/' })).status, 409);

  const other = FeedsResponseSchema.parse(await (await app.request('/feeds', { headers: as('student-b') })).json());
  assert.deepEqual(other.feeds, [], 'B never sees A’s feeds');
  assert.equal((await post(`/feeds/${feed.id}/consent`, 'student-b', { enabled: true })).status, 404);

  const consented = (await (await post(`/feeds/${feed.id}/consent`, 'student-a', { enabled: true })).json()) as Feed;
  assert.ok(consented.enabled && consented.consentedAt);
  assert.equal((await app.request(`/feeds/${feed.id}`, { method: 'DELETE', headers: as('student-a') })).status, 200);
  assert.equal((await app.request(`/feeds/${feed.id}`, { method: 'DELETE', headers: as('student-a') })).status, 404);
});
