import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitedAccessCopy, limitedReasonOf, type LimitedReason } from './limited-access';

test('only a limited session carries a limited reason', () => {
  assert.equal(limitedReasonOf(undefined), null);
  assert.equal(limitedReasonOf({ mode: 'full' }), null);
  assert.equal(limitedReasonOf({ mode: 'limited', reason: 'entitlement_expired' }), 'entitlement_expired');
  assert.equal(limitedReasonOf({ mode: 'limited', reason: 'admission_suspended' }), 'admission_suspended');
  assert.equal(limitedReasonOf({ mode: 'limited', reason: 'admission_withdrawn' }), 'admission_withdrawn');
});

test('a limited session without a reason still reads as limited, never as full', () => {
  // Version skew: an engine that omits the reason must not accidentally unlock the dashboard.
  const reason = limitedReasonOf({ mode: 'limited' });
  assert.notEqual(reason, null);
  assert.equal(reason, undefined);
});

test('every reason has honest copy and only the expired one promises a way back', () => {
  for (const reason of ['entitlement_expired', 'admission_suspended', 'admission_withdrawn'] as const) {
    const copy = limitedAccessCopy(reason);
    assert.ok(copy.title.length > 0, reason);
    assert.ok(copy.body.length > 0, reason);
  }
  const expired = limitedAccessCopy('entitlement_expired');
  assert.match(expired.restore ?? '', /sign in while online/i, 'an expired entitlement is fixed by an online sign-in');
  assert.match(expired.body, /offline entitlement has expired/i);
  assert.equal(limitedAccessCopy('admission_suspended').restore, undefined, 'suspension is not fixable from this device');
  assert.equal(limitedAccessCopy('admission_withdrawn').restore, undefined);
});

test('suspended and withdrawn say the files stay theirs, in those words', () => {
  assert.match(limitedAccessCopy('admission_suspended').body, /stay yours/i);
  assert.match(limitedAccessCopy('admission_withdrawn').body, /stay yours/i);
});

test('a reason this build predates falls back to copy that still offers the export', () => {
  for (const copy of [limitedAccessCopy(undefined), limitedAccessCopy('archived' as LimitedReason)]) {
    assert.ok(copy.title.length > 0);
    assert.match(copy.body, /export/i);
    assert.equal(copy.restore, undefined, 'an unknown reason must not promise a way back');
  }
});

test('no two reasons share the same fallback text', () => {
  const reasons: LimitedReason[] = ['entitlement_expired', 'admission_suspended', 'admission_withdrawn'];
  assert.equal(new Set(reasons.map((r) => limitedAccessCopy(r).title)).size, reasons.length);
});
