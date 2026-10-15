import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-profile-route-'));

const { profilePaths } = await import('../../config');
const { studentRoutes } = await import('./student');

const backupId = '00000000-0000-4000-8000-000000000000';

test('anonymous-data claim binds to the authenticated workspace, never a caller-supplied profile id', async () => {
  const authenticatedProfile = {
    id: 'student-from-session',
    name: 'Signed-in student',
    email: 'student@example.test',
    cohortId: 'cohort-a',
    offlineReady: true,
  };
  const paths = profilePaths(authenticatedProfile.id);
  const workspace = { profile: authenticatedProfile, paths };
  const claims: Array<{ profileId: string; paths: unknown; backupId: string }> = [];
  const deps = {
    settings: {},
    auth: { resolve: async (token: string) => token === 'valid' ? { profile: authenticatedProfile, mode: 'offline' as const } : null },
    workspaces: { get: async () => workspace },
    anonymousData: {
      preview: async () => ({ available: true }),
      backup: async () => ({ id: backupId }),
      claim: async (profile: { id: string }, selectedPaths: unknown, selectedBackupId: string) => {
        claims.push({ profileId: profile.id, paths: selectedPaths, backupId: selectedBackupId });
        return { profileId: profile.id, backupId: selectedBackupId };
      },
    },
  };
  const app = studentRoutes(deps as never);
  const headers = { authorization: 'Bearer valid', 'content-type': 'application/json' };

  const forged = await app.request('/anonymous-data/claim', {
    method: 'POST',
    headers,
    body: JSON.stringify({ backupId, profileId: 'victim' }),
  });
  assert.equal(forged.status, 400);
  assert.equal(claims.length, 0);

  const accepted = await app.request('/anonymous-data/claim', {
    method: 'POST',
    headers,
    body: JSON.stringify({ backupId }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(claims, [{ profileId: 'student-from-session', paths, backupId }]);
});
