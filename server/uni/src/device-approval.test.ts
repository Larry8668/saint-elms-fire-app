import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { SessionInfo } from './account-auth';
import { withStaffDeviceApprovalRefusal } from './device-approval';

/**
 * The device-approval guard: staff sessions never reach better-auth's approve endpoint,
 * and the refusal lands in the audit trail. Everyone else passes through untouched.
 */

const sessionFor = (id: string): SessionInfo => ({
  user: { id, email: 'x@example.test', name: 'X', emailVerified: true },
  session: null,
});

function fakePool(rows: Array<{ role: string; status?: string }>): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: sql.includes('audit_events') ? [] : rows };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const approveRequest = () =>
  new Request('http://uni.test/v1/auth/device/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode: 'ABCD-EFGH' }),
  });

const passthrough = () => async () => new Response(JSON.stringify({ success: true }), { status: 200 });

test('a staff session is refused with 403 and the refusal is audited', async () => {
  const { pool, queries } = fakePool([{ role: 'registrar', status: 'active' }]);
  let reached = false;
  const handler = withStaffDeviceApprovalRefusal(
    async () => {
      reached = true;
      return new Response('{}');
    },
    { pool, getSession: async () => sessionFor('staff-user') },
  );
  const res = await handler(approveRequest());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'staff_cannot_approve_devices' });
  assert.equal(reached, false, 'the approval never reaches better-auth');
  assert.ok(
    queries.some((sql) => sql.includes('audit_events') && sql.includes('INSERT')),
    'the refusal is written to the audit trail',
  );
});

test('a student session approves straight through', async () => {
  const { pool } = fakePool([]);
  const handler = withStaffDeviceApprovalRefusal(passthrough(), {
    pool,
    getSession: async () => sessionFor('student-user'),
  });
  const res = await handler(approveRequest());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
});

test('an anonymous caller is left for better-auth to reject', async () => {
  const { pool, queries } = fakePool([]);
  const handler = withStaffDeviceApprovalRefusal(passthrough(), { pool, getSession: async () => null });
  const res = await handler(approveRequest());
  assert.equal(res.status, 200);
  assert.equal(queries.length, 0, 'no membership lookup happens without a session');
});

test('other device paths and methods are not intercepted', async () => {
  const { pool, queries } = fakePool([{ role: 'owner' }]);
  const handler = withStaffDeviceApprovalRefusal(passthrough(), {
    pool,
    getSession: async () => sessionFor('staff-user'),
  });
  for (const request of [
    new Request('http://uni.test/v1/auth/device?user_code=ABCD-EFGH'),
    new Request('http://uni.test/v1/auth/device/code', { method: 'POST' }),
    new Request('http://uni.test/v1/auth/device/deny', { method: 'POST' }),
  ]) {
    const res = await handler(request);
    assert.equal(res.status, 200, `${request.method} ${request.url}`);
  }
  assert.equal(queries.length, 0, 'no lookups for paths the guard does not own');
});

test('a suspended membership no longer blocks approval', async () => {
  const { pool } = fakePool([{ role: 'registrar', status: 'suspended' }]);
  const handler = withStaffDeviceApprovalRefusal(passthrough(), {
    pool,
    getSession: async () => sessionFor('former-staff'),
  });
  const res = await handler(approveRequest());
  assert.equal(res.status, 200, 'only an active staff membership triggers the refusal');
});
