import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envInt, envPort } from './env';

const withVar = (value: string | undefined): NodeJS.ProcessEnv => (value === undefined ? {} : { T: value });

test('envInt returns the fallback for unset and blank values', () => {
  assert.equal(envInt('T', 42, {}, withVar(undefined)), 42);
  assert.equal(envInt('T', 42, {}, withVar('   ')), 42);
});

test('envInt accepts integers inside the range', () => {
  assert.equal(envInt('T', 0, {}, withVar('7')), 7);
  assert.equal(envInt('T', 0, { min: 0 }, withVar('0')), 0);
  assert.equal(envInt('T', 0, { min: 0 }, withVar(' 5 ')), 5);
});

test('envInt refuses non-numeric, fractional, negative and out-of-range values with a named error', () => {
  for (const raw of ['abc', '4.5', '-2', '1e3', 'NaN', '0x10', '12ms', '+5', '']) {
    const blank = raw === '';
    const env = withVar(raw);
    if (blank) {
      assert.equal(envInt('T', 9, {}, env), 9);
      continue;
    }
    assert.throws(() => envInt('T', 9, {}, env), (error: unknown) => error instanceof Error && error.message.startsWith('T must be an integer'));
  }
  assert.throws(() => envInt('T', 9, { min: 10 }, withVar('9')), /between 10/);
  assert.throws(() => envInt('T', 9, { max: 100 }, withVar('101')), /and 100/);
});

test('envPort is envInt bounded to the TCP range', () => {
  assert.equal(envPort('T', 4200, withVar('4310')), 4310);
  for (const raw of ['0', '65536', '-1', 'http://x']) {
    assert.throws(() => envPort('T', 4200, withVar(raw)), /between 1 and 65535/);
  }
});
