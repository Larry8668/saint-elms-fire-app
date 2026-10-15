/**
 * Fail-closed readers for the three responses the university serves without a shared zod
 * contract: the better-auth session, the public cohort list and the audit feed. Each mirrors
 * exactly what `server/uni` returns and returns null on anything else, so an unreadable
 * response can never be rendered as a plausible record.
 */

/** Mirrors `IdentifierSchema` in `packages/shared/src/contracts.ts`. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 128 && IDENTIFIER.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

export interface AuthSession {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  sessionId: string;
  createdAt: string | null;
}

/** `/v1/auth/get-session` answers `null` when there is no session, else `{ session, user }`. */
export function readAuthSession(raw: unknown): AuthSession | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || !isRecord(raw.user)) return null;
  const user = raw.user;
  if (typeof user.id !== 'string' || !user.id) return null;
  if (typeof user.email !== 'string' || !user.email) return null;
  const session = isRecord(raw.session) ? raw.session : null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: typeof user.name === 'string' ? user.name : '',
      emailVerified: user.emailVerified === true,
    },
    sessionId: typeof session?.id === 'string' ? session.id : '',
    createdAt: isTimestamp(session?.createdAt) ? session.createdAt : null,
  };
}

/** `/v1/auth/sign-in/email` returns `{ twoFactorRedirect, twoFactorMethods }` for an MFA account. */
export function readTwoFactorChallenge(raw: unknown): { methods: string[] } | null {
  if (!isRecord(raw) || raw.twoFactorRedirect !== true) return null;
  const methods = Array.isArray(raw.twoFactorMethods)
    ? raw.twoFactorMethods.filter((m): m is string => typeof m === 'string')
    : [];
  return { methods };
}

export interface Cohort {
  id: string;
  name: string;
}

/** `GET /v1/cohorts` answers `[{ id, name }]`. */
export function readCohorts(raw: unknown): Cohort[] | null {
  if (!Array.isArray(raw)) return null;
  const cohorts: Cohort[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !isIdentifier(entry.id) || typeof entry.name !== 'string') return null;
    cohorts.push({ id: entry.id, name: entry.name });
  }
  return cohorts;
}

export interface AuditEvent {
  id: string;
  actor: string;
  event: string;
  subjectType: string;
  subjectId: string;
  details: Record<string, unknown>;
  at: string;
}

/** `GET /v1/admin/audit-events` answers the `AuditEventRow` mapping in `server/uni/src/routes/staff.ts`. */
export function readAuditEvents(raw: unknown): AuditEvent[] | null {
  if (!Array.isArray(raw)) return null;
  const events: AuditEvent[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    if (typeof entry.id !== 'string' || typeof entry.actor !== 'string' || typeof entry.event !== 'string') return null;
    if (typeof entry.subjectType !== 'string' || typeof entry.subjectId !== 'string') return null;
    if (!isTimestamp(entry.at)) return null;
    events.push({
      id: entry.id,
      actor: entry.actor,
      event: entry.event,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      details: isRecord(entry.details) ? entry.details : {},
      at: entry.at,
    });
  }
  return events;
}