import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSourceBytes } from './sources';

test('standard base64 decodes, and padding is not required to match byte-for-byte', () => {
  const body = 'a note body';
  const decoded = decodeSourceBytes(Buffer.from(body, 'utf8').toString('base64'));
  assert.equal(decoded && Buffer.from(decoded).toString('utf8'), body);
  assert.equal(decodeSourceBytes(Buffer.from(body, 'utf8').toString('base64').replace(/=+$/, '')) && 'ok', 'ok');
});

test('the URL-safe alphabet is accepted, not rejected for spelling the same bytes differently', () => {
  // 0xff bytes force the `+` and `/` characters the URL-safe alphabet writes as `-`/`_`.
  const raw = Buffer.from([0xff, 0xff, 0xff, 0x41, 0xfb, 0xef]);
  const standard = raw.toString('base64');
  assert.match(standard, /[+/]/, 'the fixture must actually exercise both alphabets');
  const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
  assert.deepEqual(decodeSourceBytes(urlSafe), new Uint8Array(raw));
});

test('whitespace a transport folded in is tolerated', () => {
  const standard = Buffer.from('wrapped', 'utf8').toString('base64');
  const decoded = decodeSourceBytes(`${standard.slice(0, 4)}\n  ${standard.slice(4)}`);
  assert.equal(decoded && Buffer.from(decoded).toString('utf8'), 'wrapped');
});

test('input that is not base64 at all is refused, not silently zero-filled', () => {
  assert.equal(decodeSourceBytes('!!! not base64 !!!'), null);
  assert.equal(decodeSourceBytes('@@@@'), null);
});
