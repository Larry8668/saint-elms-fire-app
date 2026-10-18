import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PASSWORD_DEFAULT } from '@sef/shared';
import { engineTarget } from '@/lib/seat';
import { matchDemoProfile, personaClick, promptSubmit } from './demo-sign-in';
import { signInCopyMode } from './sign-in-copy';

const email = 'ananya@saintelms.local';

test('locally a persona button still signs in with one click', () => {
  assert.deepEqual(personaClick(signInCopyMode(engineTarget('http://127.0.0.1:4910', null)), email), { kind: 'sign-in', email, password: DEMO_PASSWORD_DEFAULT });
  assert.deepEqual(personaClick(signInCopyMode(engineTarget('same-origin', 'localhost')), email).kind, 'sign-in');
});

test('on a hosted workspace a persona button opens the password prompt and sends nothing', () => {
  const click = personaClick(signInCopyMode(engineTarget('same-origin', '4100-abc.instabox.tech')), email);
  assert.deepEqual(click, { kind: 'prompt', email });
  assert.equal(JSON.stringify(click).includes(DEMO_PASSWORD_DEFAULT), false, 'the public password never leaves on a hosted workspace');
  // The web app on Vercel, handed a workspace by the portal.
  assert.deepEqual(personaClick(signInCopyMode({ kind: 'workspace', base: 'https://4100-abc.instabox.tech', host: '4100-abc.instabox.tech' }), email), { kind: 'prompt', email });
});

test('the prompt sends exactly what was typed, and nothing when empty', () => {
  assert.equal(promptSubmit(email, ''), null);
  assert.deepEqual(promptSubmit(email, 'typed-secret'), { kind: 'sign-in', email, password: 'typed-secret' });
});

const accounts = [
  { id: 'ananya', email: 'ananya@saintelms.local' },
  { id: 'rohan', email: 'rohan@saintelms.local' },
];

test('a lone profile that is a demo account preselects its persona', () => {
  assert.equal(matchDemoProfile([{ id: 'x1', email: 'Ananya@saintelms.local' }], accounts), 'ananya@saintelms.local');
  assert.equal(matchDemoProfile([{ id: 'rohan', email: 'other@uni.edu' }], accounts), 'rohan@saintelms.local', 'matches by id too');
});

test('no, many or non-demo profiles preselect nothing', () => {
  assert.equal(matchDemoProfile(undefined, accounts), null);
  assert.equal(matchDemoProfile([], accounts), null);
  assert.equal(matchDemoProfile([{ id: 'z', email: 'real@uni.edu' }], accounts), null);
  assert.equal(
    matchDemoProfile(
      [
        { id: 'ananya', email: 'ananya@saintelms.local' },
        { id: 'rohan', email: 'rohan@saintelms.local' },
      ],
      accounts,
    ),
    null,
  );
});
