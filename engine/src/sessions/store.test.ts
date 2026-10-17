import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionStore, type Session } from './store';

const session = (id: string, teacher: Session['teacher'], turns: Array<[string, string]>, lessonIds: string[] = []): Session => ({
  id,
  teacher,
  startedAt: turns[0]?.[1] ?? '2026-10-01T00:00:00Z',
  updatedAt: turns.at(-1)?.[1] ?? '2026-10-01T00:00:00Z',
  turns: turns.flatMap(([content, at]) => [
    { role: 'user' as const, content, at },
    { role: 'assistant' as const, content: `re: ${content}`, at },
  ]),
  lessonIds,
  sources: [],
  ingestedTurns: 0,
});

test('recentUserTurns: only the student’s own messages to that teacher, newest first, capped', async () => {
  const store = new SessionStore(await mkdtemp(path.join(tmpdir(), 'sef-sessions-')));
  await store.put(session('s1', 'guide', [['old', '2026-10-01T00:00:00Z'], ['newer', '2026-10-03T00:00:00Z']]));
  await store.put(session('s2', 'guide', [['newest', '2026-10-05T00:00:00Z']]));
  await store.put(session('s3', 'friend', [['friend only', '2026-10-06T00:00:00Z']]));
  assert.deepEqual(await store.recentUserTurns('guide'), ['newest', 'newer', 'old']);
  assert.deepEqual(await store.recentUserTurns('guide', 2), ['newest', 'newer']);
});

test('studiedLessonIds unions lessons across every conversation', async () => {
  const store = new SessionStore(await mkdtemp(path.join(tmpdir(), 'sef-sessions-')));
  await store.put(session('s1', 'guide', [['q', '2026-10-01T00:00:00Z']], ['l1', 'l2']));
  await store.put(session('s2', 'philosopher', [['q', '2026-10-02T00:00:00Z']], ['l2', 'l3']));
  assert.deepEqual((await store.studiedLessonIds()).sort(), ['l1', 'l2', 'l3']);
});
