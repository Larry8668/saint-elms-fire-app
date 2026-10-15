import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { emptyPage } from '../brain/page-format';

process.env.ENGINE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'sef-profile-isolation-'));

const { profilePaths } = await import('../config');
const { WorkspaceManager } = await import('./workspace');

const profile = (id: string, name = id) => ({ id, name, email: `${id}@example.test`, cohortId: 'cohort-a', offlineReady: true });
const noopSettings = { get: async () => ({}) };
const registry = { get: async () => undefined, uniToken: async () => undefined };

function manager() {
  return new WorkspaceManager(noopSettings as never, registry as never);
}

const blankSession = (id: string, content: string) => ({
  id,
  teacher: 'guide' as const,
  startedAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
  turns: [{ role: 'user' as const, content, at: '2026-10-15T00:00:00.000Z' }],
  lessonIds: [],
  sources: [],
  ingestedTurns: 0,
});

test('profile paths distinguish ids that previously collapsed to the same sanitized directory', () => {
  assert.notEqual(profilePaths('alice!').root, profilePaths('alice').root);
  assert.notEqual(profilePaths('../alice').root, profilePaths('alice').root);
  assert.notEqual(profilePaths('Alice').root.toLowerCase(), profilePaths('alice').root.toLowerCase());
});

test('profiles with identical session ids keep delayed writes and stores isolated', async () => {
  const workspaces = manager();
  const alice = await workspaces.get(profile('alice!'));
  const bob = await workspaces.get(profile('alice'));
  assert.notEqual(alice.paths.root, bob.paths.root);
  assert.notStrictEqual(alice.content, bob.content);
  assert.notStrictEqual(alice.brain, bob.brain);
  assert.notEqual(alice.paths.quizzes, bob.paths.quizzes);
  await alice.vault.writeSeeded(emptyPage('same-page', 'Alice concept', [], '2026-10-15T00:00:00.000Z'));
  await bob.vault.writeSeeded(emptyPage('same-page', 'Bob concept', [], '2026-10-15T00:00:00.000Z'));
  assert.equal((await alice.vault.get('same-page'))?.concept, 'Alice concept');
  assert.equal((await bob.vault.get('same-page'))?.concept, 'Bob concept');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayedWrite = gate.then(() => alice.sessions.put(blankSession('same-session', 'Alice private turn')));
  await bob.sessions.put(blankSession('same-session', 'Bob private turn'));
  release();
  await delayedWrite;

  assert.equal((await alice.sessions.get('same-session'))?.turns[0]?.content, 'Alice private turn');
  assert.equal((await bob.sessions.get('same-session'))?.turns[0]?.content, 'Bob private turn');
});

test('a later request gets refreshed profile metadata without mutating an in-flight workspace', async () => {
  const workspaces = manager();
  const original = await workspaces.get(profile('same-id', 'Old name'));
  const refreshed = await workspaces.get(profile('same-id', 'Updated name'));

  assert.notStrictEqual(original, refreshed);
  assert.equal(original.profile.name, 'Old name');
  assert.equal(refreshed.profile.name, 'Updated name');
  assert.strictEqual(original.sessions, refreshed.sessions);
  assert.strictEqual(original.paths, refreshed.paths);
});
