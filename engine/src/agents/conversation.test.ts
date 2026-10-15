import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConversationRefused, ConversationRegistry, serverTranscript } from './conversation';

const STUDENT = 'student-one';
const OTHER = 'student-two';

async function registry() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-conversations-'));
  let counter = 0;
  const conversations = new ConversationRegistry({
    dirFor: (profileId) => path.join(dir, profileId),
    newId: () => `s-${++counter}`,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return { conversations, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const rejectionOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ConversationRefused, `expected a refusal, got ${String(error)}`);
    return error.rejection;
  }
  return assert.fail('the turn was accepted');
};

test('an invented or unknown session id is refused', async () => {
  const { conversations, cleanup } = await registry();
  try {
    assert.equal(
      await rejectionOf(() => conversations.admit({ sessionId: 's-does-not-exist', profileId: STUDENT, teacher: 'guide', clientMessageId: 'm1' })),
      'unknown_session',
    );
  } finally {
    await cleanup();
  }
});

test("another student's session is refused as theirs, not as unknown", async () => {
  const { conversations, cleanup } = await registry();
  try {
    const theirs = await conversations.open({ profileId: OTHER, teacher: 'guide' });
    assert.equal(
      await rejectionOf(() => conversations.admit({ sessionId: theirs.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm1' })),
      'session_owner_mismatch',
    );
    assert.equal(conversations.get(STUDENT, theirs.id), null, 'the other student does not see it as theirs');
  } finally {
    await cleanup();
  }
});

test('asking a Guide question in the Friend’s slot is refused', async () => {
  const { conversations, cleanup } = await registry();
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'friend' });
    assert.equal(
      await rejectionOf(() => conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm1' })),
      'teacher_mismatch',
    );
    const admitted = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'friend', clientMessageId: 'm1' });
    assert.equal(admitted.session.teacher, 'friend', 'the session keeps the teacher it was issued for');
  } finally {
    await cleanup();
  }
});

test('a replayed turn is refused once its id has been taken', async () => {
  const { conversations, cleanup } = await registry();
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'guide' });
    await conversations.complete(await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' }));
    assert.equal(
      await rejectionOf(() => conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' })),
      'replayed_turn',
    );
    const next = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-2' });
    await conversations.complete(next);
    assert.equal(next.session.turnCount, 2);
  } finally {
    await cleanup();
  }
});

test('two turns on one session at once: the second is refused', async () => {
  const { conversations, cleanup } = await registry();
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'guide' });
    const first = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' });
    assert.equal(
      await rejectionOf(() => conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-2' })),
      'concurrent_turn',
    );
    await conversations.complete(first);
    const after = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-2' });
    await conversations.complete(after);
    assert.equal(after.session.turnCount, 2, 'the released claim lets the next turn through');
  } finally {
    await cleanup();
  }
});

test('a failed turn releases its claim instead of wedging the session', async () => {
  const { conversations, cleanup } = await registry();
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'guide' });
    const first = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' });
    conversations.release(session.id);
    const retry = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' });
    await conversations.complete(retry);
    assert.equal(retry.session.turnCount, 1);
    assert.equal(first.session.turnCount, 1, 'the released turn was never recorded as taken');
  } finally {
    await cleanup();
  }
});

test('a hand-off is the only way to change teacher, and it closes the old conversation', async () => {
  const { conversations, cleanup } = await registry();
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'friend' });
    const moved = await conversations.handoff({ sessionId: session.id, profileId: STUDENT, to: 'guide', reason: 'Academic question' });
    assert.equal(moved.teacher, 'guide');
    assert.notEqual(moved.id, session.id, 'a new conversation is issued rather than edited');
    assert.equal(await rejectionOf(() => conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' })), 'session_closed');
    const admitted = await conversations.admit({ sessionId: moved.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' });
    assert.equal(admitted.session.id, moved.id);
  } finally {
    await cleanup();
  }
});

test('closing a conversation ends it without a successor — a deleted transcript cannot still answer', async () => {
  const { conversations, cleanup } = await registry();
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'guide' });
    assert.equal(await conversations.close({ sessionId: session.id, profileId: STUDENT }), true);
    assert.equal(await rejectionOf(() => conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' })), 'session_closed');
    assert.equal(await conversations.close({ sessionId: session.id, profileId: STUDENT }), false, 'already closed is a no-op');
    assert.equal(await conversations.close({ sessionId: 's-missing', profileId: STUDENT }), false, 'unknown ids are a no-op');
    const theirs = await conversations.open({ profileId: OTHER, teacher: 'guide' });
    assert.equal(await conversations.close({ sessionId: theirs.id, profileId: STUDENT }), false, "one student cannot close another's");
  } finally {
    await cleanup();
  }
});

test('sessions survive a restart and stay bound to the student who opened them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sef-conversations-restart-'));
  try {
    let counter = 0;
    const options = { dirFor: (profileId: string) => path.join(dir, profileId), newId: () => `s-${++counter}` };
    const before = new ConversationRegistry(options);
    const session = await before.open({ profileId: STUDENT, teacher: 'guide' });
    await before.complete(await before.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' }));

    const after = new ConversationRegistry(options);
    assert.equal(await rejectionOf(() => after.admit({ sessionId: session.id, profileId: OTHER, teacher: 'guide', clientMessageId: 'm-9' })), 'unknown_session');
    const admitted = await after.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-2' });
    assert.equal(admitted.session.turnCount, 1, 'the record came back off disk');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a turn whose record cannot be persisted does not count as replayed', async () => {
  const good = await mkdtemp(path.join(tmpdir(), 'sef-conversations-good-'));
  const bad = path.join(good, 'not-a-dir');
  await writeFile(bad, 'x'); // a file where a directory is expected: writes under it fail with ENOTDIR
  let dir = good;
  let counter = 0;
  const conversations = new ConversationRegistry({
    dirFor: (profileId) => path.join(dir, profileId),
    newId: () => `s-${++counter}`,
  });
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'guide' });
    const admitted = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' });
    dir = bad;
    await assert.rejects(() => conversations.complete(admitted));
    dir = good;
    const again = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-1' });
    await conversations.complete(again);
    assert.equal(conversations.get(STUDENT, session.id)?.turnCount, 1);
  } finally {
    await rm(good, { recursive: true, force: true });
  }
});

test('a hand-off that cannot issue its successor leaves the old thread open', async () => {
  const good = await mkdtemp(path.join(tmpdir(), 'sef-conversations-good-'));
  const bad = path.join(good, 'not-a-dir');
  await writeFile(bad, 'x');
  let dir = good;
  let counter = 0;
  const conversations = new ConversationRegistry({
    dirFor: (profileId) => path.join(dir, profileId),
    newId: () => `s-${++counter}`,
  });
  try {
    const session = await conversations.open({ profileId: STUDENT, teacher: 'guide' });
    dir = bad;
    await assert.rejects(() => conversations.handoff({ sessionId: session.id, profileId: STUDENT, to: 'friend', reason: 'campus question' }));
    dir = good;
    const admitted = await conversations.admit({ sessionId: session.id, profileId: STUDENT, teacher: 'guide', clientMessageId: 'm-2' });
    await conversations.complete(admitted);
    assert.equal(conversations.get(STUDENT, session.id)?.turnCount, 1);
  } finally {
    await rm(good, { recursive: true, force: true });
  }
});

test('the transcript is the server’s stored turns plus the one accepted message', () => {
  const stored = {
    turns: [
      { role: 'user' as const, content: 'fees?', at: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant' as const, content: 'Fees are due in week 6.', at: '2026-01-01T00:00:01.000Z' },
    ],
  };
  const transcript = serverTranscript(stored, { role: 'user', content: 'and the deadline?' });
  assert.deepEqual(
    transcript.map((m) => [m.role, m.content]),
    [
      ['user', 'fees?'],
      ['assistant', 'Fees are due in week 6.'],
      ['user', 'and the deadline?'],
    ],
  );
  assert.equal(serverTranscript(null, { role: 'user', content: 'first' }).length, 1);
});