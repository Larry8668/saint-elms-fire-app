import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_ACCOUNTS } from '@/lib/demo-accounts';
import { DEMO_START, pickPersona, submitDemoSignIn, type DemoSignIn } from './demo-sign-in';
import { PortalError } from './portal-api';

const recorder = () => {
  const seen: DemoSignIn[] = [];
  return { seen, emit: (s: DemoSignIn) => seen.push(s) };
};

test('the three personas are offered with their programme stage', () => {
  assert.deepEqual(
    DEMO_ACCOUNTS.map((a) => [a.id, a.label, a.detail]),
    [
      ['ananya', 'First-year student', 'Semester 1, week 6'],
      ['brinda', 'Second-year student', 'End of Semester 3'],
      ['chetna', 'Third-year student', 'Semester 5, thesis prep'],
    ],
  );
});

test('nothing is sent without a persona or a password', async () => {
  let calls = 0;
  const login = async () => {
    calls += 1;
  };
  const r = recorder();
  const noPersona = await submitDemoSignIn(DEMO_START, 'pw', login, r.emit);
  assert.equal(noPersona.phase === 'choosing' && noPersona.error?.code, 'no_persona');
  const noPassword = await submitDemoSignIn(pickPersona(DEMO_START, 'ananya'), '', login, r.emit);
  assert.equal(noPassword.phase === 'choosing' && noPassword.error?.code, 'no_password');
  assert.equal(calls, 0);
});

test('a picked persona and password sign in through the legacy login', async () => {
  const sent: Array<[string, string]> = [];
  const r = recorder();
  const final = await submitDemoSignIn(pickPersona(DEMO_START, 'brinda'), 'typed', async (email, password) => void sent.push([email, password]), r.emit);
  assert.deepEqual(sent, [['brinda@saintelms.local', 'typed']]);
  assert.deepEqual(r.seen.map((s) => s.phase), ['submitting', 'signed-in']);
  assert.equal(final.phase === 'signed-in' && final.persona.id, 'brinda');
});

test('a refused password returns to the form with the persona still picked and the mapped copy', async () => {
  const r = recorder();
  const final = await submitDemoSignIn(
    pickPersona(DEMO_START, 'ananya'),
    'wrong',
    async () => {
      throw new PortalError('That password does not match this demo student.', 401, 'invalid_credentials');
    },
    r.emit,
  );
  assert.deepEqual(final, { phase: 'choosing', personaId: 'ananya', error: { message: 'That password does not match this demo student.', code: 'invalid_credentials' } });
  assert.doesNotMatch(JSON.stringify(final), /wrong/, 'the typed password is not kept in state');
});

test('a submit while one is in flight is ignored', async () => {
  const busy: DemoSignIn = { phase: 'submitting', persona: DEMO_ACCOUNTS[0]! };
  assert.equal(await submitDemoSignIn(busy, 'pw', async () => assert.fail('must not send'), () => assert.fail('must not emit')), busy);
  assert.equal(pickPersona(busy, 'chetna'), busy);
});
