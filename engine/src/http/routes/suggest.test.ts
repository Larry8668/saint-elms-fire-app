import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SuggestionsResponseSchema } from '@sef/shared';
import { SuggestionService } from '../../suggest/service';
import { SuggestionStore } from '../../suggest/store';
import { logisticsRecord, richInputs } from '../../suggest/testing/fixtures';
import { suggestRoutes } from './suggest';

const dir = await mkdtemp(path.join(tmpdir(), 'sef-suggest-route-'));
const profileA = { id: 'student-a', name: 'A', email: 'a@example.test', cohortId: 'c-1', offlineReady: true, admission: 'approved' };
const profileB = { ...profileA, id: 'student-b', email: 'b@example.test' };

const service = (id: string, logistics: ReturnType<typeof logisticsRecord>[]) =>
  new SuggestionService({
    store: new SuggestionStore(path.join(dir, id)),
    inputs: async () => ({ ...richInputs(), logistics }),
    recentTurns: async () => [],
    proactivity: async () => ({ nudges: true, draftedAdvice: false }),
  });

const workspaces = new Map([
  [profileA.id, { profile: profileA, suggestions: service(profileA.id, [logisticsRecord('a-only', { title: 'A private deadline' })]) }],
  [profileB.id, { profile: profileB, suggestions: service(profileB.id, []) }],
]);
const deps = {
  auth: { resolve: async (token: string) => (workspaces.has(token) ? { profile: workspaces.get(token)!.profile, mode: 'offline' as const } : null) },
  workspaces: { get: async (profile: typeof profileA) => workspaces.get(profile.id) },
};
const app = suggestRoutes(deps as never);
const as = (id: string) => ({ authorization: `Bearer ${id}` });

test('suggestions sit behind the profile session and reject unknown teachers', async () => {
  assert.equal((await app.request('/teachers/friend/suggestions')).status, 401);
  assert.equal((await app.request('/teachers/oracle/suggestions', { headers: as('student-a') })).status, 404);
});

test('each profile sees only suggestions built from its own stores', async () => {
  const a = SuggestionsResponseSchema.parse(await (await app.request('/teachers/friend/suggestions', { headers: as('student-a') })).json());
  const b = SuggestionsResponseSchema.parse(await (await app.request('/teachers/friend/suggestions', { headers: as('student-b') })).json());
  assert.ok(a.questions.some((q) => q.text.includes('A private deadline')));
  assert.ok(b.questions.every((q) => !q.text.includes('A private deadline')));
});
