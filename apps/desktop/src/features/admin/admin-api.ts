import type {
  Account,
  AccountPatch,
  AdminCourse,
  AdminLesson,
  AdminOverview,
  AdminShare,
  AuditEntry,
  CohortSummary,
  DispersalRecord,
  NewAccount,
} from '@sef/shared';
import { log } from '@/lib/log';

export class UniError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type DispersalRow = DispersalRecord & { current: boolean };

const MESSAGES: Record<string, string> = {
  email_taken: 'An account with that email already exists.',
  unknown_cohort: 'That cohort does not exist.',
  cohort_exists: 'A cohort with that id already exists.',
  cannot_disable_self: "You can't disable your own account.",
  invalid_request: 'Some fields are missing or invalid.',
};

/** Thin client for the uni admin API. Created per admin session. */
export function createAdminApi(baseUrl: string, token: string, onExpired: () => void) {
  const root = baseUrl.replace(/\/+$/, '');

  async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method: init?.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, ...(init?.body !== undefined && { 'content-type': 'application/json' }) },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      log.error('uni_unreachable', { path, error: String(error) });
      throw new UniError('The university server is unreachable.', 0);
    }
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      log.warn('admin_request_failed', { path, status: res.status, error: body.error });
      if (res.status === 401) onExpired();
      throw new UniError(MESSAGES[body.error ?? ''] ?? body.error ?? `Request failed (${res.status})`, res.status);
    }
    return body;
  }

  return {
    overview: () => call<AdminOverview>('/v1/admin/overview'),
    cohorts: () => call<CohortSummary[]>('/v1/admin/cohorts'),
    createCohort: (input: { id: string; name: string; copyFrom?: string }) => call<CohortSummary>('/v1/admin/cohorts', { method: 'POST', body: input }),
    setReleased: (cohortId: string, courseIds: string[], released: boolean) =>
      call<CohortSummary>(`/v1/admin/cohorts/${encodeURIComponent(cohortId)}/releases`, { method: 'PUT', body: { courseIds, released } }),
    courses: () => call<AdminCourse[]>('/v1/admin/courses'),
    lessons: (courseId: string) => call<AdminLesson[]>(`/v1/admin/courses/${encodeURIComponent(courseId)}/lessons`),
    accounts: () => call<Account[]>('/v1/admin/accounts'),
    createAccount: (input: NewAccount) => call<Account>('/v1/admin/accounts', { method: 'POST', body: input }),
    updateAccount: (id: string, patch: AccountPatch) => call<Account>(`/v1/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    dispersal: () => call<DispersalRow[]>('/v1/admin/dispersal'),
    audit: (limit = 200) => call<AuditEntry[]>(`/v1/admin/audit?limit=${limit}`),
    shares: () => call<AdminShare[]>('/v1/admin/shares'),
    removeShare: (id: string) => call<void>(`/v1/admin/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
