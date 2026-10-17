import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { GATEWAY_TOKEN_MAX_TTL_SECONDS, mintGatewayToken, parseGatewayDevTokens, verifyGatewayToken } from './gateway-token';

const SECRET = 'a'.repeat(40);
const opts = { secret: SECRET, devTokens: [] };
const bearer = (t: string) => `Bearer ${t}`;

test('a minted token verifies and carries sub, vm and exp', () => {
  const now = Date.UTC(2026, 9, 17);
  const token = mintGatewayToken(SECRET, { sub: 'acct_1', vm: 'm_abc', ttlSeconds: 600 }, now);
  const result = verifyGatewayToken(bearer(token), { ...opts, nowMs: now + 1000 });
  assert.deepEqual(result, { ok: true, claims: { sub: 'acct_1', vm: 'm_abc', exp: now / 1000 + 600 }, dev: false });
});

test('expired tokens are refused', () => {
  const now = Date.now();
  const token = mintGatewayToken(SECRET, { sub: 'acct_1', ttlSeconds: 60 }, now);
  assert.deepEqual(verifyGatewayToken(bearer(token), { ...opts, nowMs: now + 61_000 }), { ok: false, reason: 'expired' });
});

test('a tampered payload or signature is refused', () => {
  const token = mintGatewayToken(SECRET, { sub: 'acct_1', ttlSeconds: 60 });
  const [prefix, body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'acct_2', exp: 9e9 })).toString('base64url');
  assert.equal(verifyGatewayToken(bearer(`${prefix}.${forged}.${sig}`), opts).ok, false);
  const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
  assert.deepEqual(verifyGatewayToken(bearer(`${prefix}.${body}.${flipped}`), opts), { ok: false, reason: 'bad_signature' });
});

test('a token signed with another secret is refused', () => {
  const token = mintGatewayToken('b'.repeat(40), { sub: 'acct_1', ttlSeconds: 60 });
  assert.deepEqual(verifyGatewayToken(bearer(token), opts), { ok: false, reason: 'bad_signature' });
});

test('missing, malformed and over-long-lived tokens are refused', () => {
  assert.deepEqual(verifyGatewayToken(undefined, opts), { ok: false, reason: 'missing' });
  for (const header of ['Basic abc', 'Bearer', 'Bearer a.b', 'Bearer sefgw1..', 'Bearer x.y.z']) {
    assert.equal(verifyGatewayToken(header, opts).ok, false, header);
  }
  // Correctly signed but claiming an exp beyond the lifetime ceiling: not something mintGatewayToken makes.
  const body = Buffer.from(JSON.stringify({ sub: 'a', exp: Math.floor(Date.now() / 1000) + GATEWAY_TOKEN_MAX_TTL_SECONDS * 2 })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`sefgw1.${body}`).digest('base64url');
  assert.deepEqual(verifyGatewayToken(bearer(`sefgw1.${body}.${sig}`), opts), { ok: false, reason: 'malformed' });
  assert.throws(() => mintGatewayToken('short', { sub: 'a', ttlSeconds: 1 }));
  assert.throws(() => mintGatewayToken(SECRET, { sub: 'a', ttlSeconds: GATEWAY_TOKEN_MAX_TTL_SECONDS + 1 }));
  assert.throws(() => mintGatewayToken(SECRET, { sub: 'has space', ttlSeconds: 1 }));
});

test('dev tokens verify with their subject; signed tokens need a secret', () => {
  const devTokens = parseGatewayDevTokens('local-dev-token-0001:ananya, local-dev-token-0002');
  assert.deepEqual(verifyGatewayToken(bearer('local-dev-token-0001'), { devTokens }), {
    ok: true,
    claims: { sub: 'ananya', exp: Number.MAX_SAFE_INTEGER },
    dev: true,
  });
  const second = verifyGatewayToken(bearer('local-dev-token-0002'), { devTokens });
  assert.equal(second.ok && second.claims.sub, 'dev-2');
  assert.equal(verifyGatewayToken(bearer('local-dev-token-0003'), { devTokens }).ok, false);
  assert.equal(verifyGatewayToken(bearer(mintGatewayToken(SECRET, { sub: 'a', ttlSeconds: 9 })), { devTokens }).ok, false);
  assert.throws(() => parseGatewayDevTokens('short'));
});

test('known-answer vector: the wire format other minters (PR-42) must reproduce', () => {
  // secret 'k' x 32, claims {"sub":"acct_42","vm":"m_vector","exp":1792198800} (2026-10-17T01:00:00Z)
  const token = mintGatewayToken('k'.repeat(32), { sub: 'acct_42', vm: 'm_vector', ttlSeconds: 3600 }, Date.UTC(2026, 9, 17));
  assert.equal(token, 'sefgw1.eyJzdWIiOiJhY2N0XzQyIiwidm0iOiJtX3ZlY3RvciIsImV4cCI6MTc5MjE5ODgwMH0.K-9YXSjBeVFadRLX5CeNvrzidPzorAPD4uQUqHsDN08');
  assert.equal(Buffer.from(token.split('.')[1], 'base64url').toString(), '{"sub":"acct_42","vm":"m_vector","exp":1792198800}');
});
