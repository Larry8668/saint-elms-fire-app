import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeShareCursor, ShareError } from './shares';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const UUID = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';

test('decodeShareCursor accepts absent and well-formed cursors', () => {
  assert.equal(decodeShareCursor(undefined), null);
  const cursor = decodeShareCursor(encode({ t: '2026-03-01T10:00:00.000Z', i: UUID }));
  assert.equal(cursor!.id, UUID);
  assert.equal(cursor!.createdAt.toISOString(), '2026-03-01T10:00:00.000Z');
});

test('decodeShareCursor rejects malformed cursors instead of trusting them', () => {
  for (const raw of [
    'not-base64!!!',
    Buffer.from('not json', 'utf8').toString('base64url'),
    encode({ t: 'not-a-date', i: UUID }),
    encode({ t: '2026-03-01T10:00:00.000Z', i: "injected') OR 1=1 --" }),
    encode({ t: '2026-03-01T10:00:00.000Z' }),
    encode('a string, not an object'),
  ]) {
    assert.throws(() => decodeShareCursor(raw), (error: unknown) => error instanceof ShareError && error.code === 'invalid_cursor');
  }
});
