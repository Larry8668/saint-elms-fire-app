import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { ENGINE_AUDIENCE, type TokenClaims } from '@sef/shared';
import { signToken } from '@sef/shared/node';
import { verifyEntitlement } from './entitlement';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const DEVICE = 'device-0001';
const PROFILE = 'user-0001';
const NOW = new Date('2026-10-15T12:00:00Z');

const issue = (overrides: Partial<TokenClaims> = {}): string =>
  signToken(
    {
      iss: 'saint-elms.test',
      sub: PROFILE,
      role: 'student',
      name: 'Ananya',
      email: 'ananya@test',
      cohortId: 'cohort-a',
      aud: ENGINE_AUDIENCE,
      dev: DEVICE,
      iat: Math.floor(NOW.getTime() / 1000) - 60,
      exp: Math.floor(NOW.getTime() / 1000) + 3600,
      ...overrides,
    },
    privateKey,
  );

const check = (token: string) => verifyEntitlement(token, publicKeyPem, { profileId: PROFILE, deviceId: DEVICE }, NOW);

test('a properly bound entitlement verifies with all checks', () => {
  const result = check(issue());
  assert.ok(result.ok);
  assert.equal(result.ok && result.entitlement.claims.sub, PROFILE);
  assert.equal(result.ok && result.entitlement.claims.cohortId, 'cohort-a');
});

test('tampered signatures and wrong keys are rejected', () => {
  const token = issue();
  const flipAt = 20;
  const tampered = `${token.slice(0, flipAt)}${token[flipAt] === 'a' ? 'b' : 'a'}${token.slice(flipAt + 1)}`;
  assert.deepEqual(check(tampered), { ok: false, reason: 'signature' });

  const other = generateKeyPairSync('ed25519');
  const foreign = signToken(
    { iss: 'evil', sub: PROFILE, role: 'student', name: 'x', email: 'x', aud: ENGINE_AUDIENCE, dev: DEVICE, iat: 0, exp: 9999999999 },
    other.privateKey,
  );
  assert.deepEqual(check(foreign), { ok: false, reason: 'signature' });
});

test('wrong audience, profile or device cannot reuse the credential', () => {
  assert.deepEqual(check(issue({ aud: 'sef-admin' })), { ok: false, reason: 'audience' });
  assert.deepEqual(check(issue({ aud: undefined })), { ok: false, reason: 'audience' });
  assert.deepEqual(check(issue({ sub: 'someone-else' })), { ok: false, reason: 'profile' });
  assert.deepEqual(check(issue({ dev: 'another-device' })), { ok: false, reason: 'device' });
  assert.deepEqual(check(issue({ dev: undefined })), { ok: false, reason: 'device' });
});

test('expired entitlements are distinguished from invalid ones', () => {
  const result = check(issue({ exp: Math.floor(NOW.getTime() / 1000) - 1 }));
  assert.deepEqual(result, { ok: false, reason: 'expired' });
});

test('no pinned key means nothing verifies', () => {
  assert.deepEqual(verifyEntitlement(issue(), null, { profileId: PROFILE, deviceId: DEVICE }, NOW), { ok: false, reason: 'no_key' });
});
