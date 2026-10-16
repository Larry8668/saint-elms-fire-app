import type { Pool } from 'pg';
import type { SessionInfo } from './account-auth';
import { recordAuditEvent } from './audit-events';
import { SECURITY_HEADERS } from './routes/account';
import { activeStaffRoles } from './staff';

const DEVICE_APPROVE_PATH = '/v1/auth/device/approve';

/**
 * Device-grant sessions are for students: a device approved by a staff account would hold a
 * full session that passes every `/v1/admin/*` check. better-auth lets any signed-in account
 * approve a code, so the refusal lives here — wrapping the account handler, it covers the
 * `/device` page flow and any direct JSON approve call on the single mounted path.
 */
export function withStaffDeviceApprovalRefusal(
  handler: (request: Request) => Promise<Response>,
  deps: { pool: Pool; getSession: (headers: Headers) => Promise<SessionInfo | null> },
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== DEVICE_APPROVE_PATH) return handler(request);

    const session = await deps.getSession(request.headers);
    // Unauthenticated callers fall through: better-auth answers them itself.
    if (!session) return handler(request);
    const staffRoles = await activeStaffRoles(deps.pool, session.user.id);
    if (staffRoles.length === 0) return handler(request);

    await recordAuditEvent(deps.pool, {
      actor: session.user.id,
      event: 'device_approval.refused_staff',
      subjectType: 'account',
      subjectId: session.user.id,
    });
    return new Response(JSON.stringify({ error: 'staff_cannot_approve_devices' }), {
      status: 403,
      headers: { 'content-type': 'application/json', ...SECURITY_HEADERS },
    });
  };
}
