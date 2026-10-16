import type {
  Account,
  AccountPatch,
  AdminCourse,
  AdminLesson,
  AdminOverview,
  AdminShare,
  AdminShareDetail,
  AdminSharePage,
  AuditEntry,
  CohortSummary,
  DispersalRecord,
  LegacySharePage,
  NewAccount,
  PublishedShare,
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

    // Session-staff share moderation. Removal is reserved for fresh staff sessions —
    // a legacy admin bearer can list and read, and gets an honest refusal on remove.
    publishedShares: (query: { cursor?: string; cohort?: string; state?: 'published' | 'withdrawn' } = {}) => {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.cohort) params.set('cohort', query.cohort);
      if (query.state) params.set('state', query.state);
      const qs = params.toString();
      return call<AdminSharePage>(`/v1/admin/published-shares${qs ? `?${qs}` : ''}`);
    },
    publishedShare: (id: string) => call<AdminShareDetail>(`/v1/admin/published-shares/${encodeURIComponent(id)}`),
    removePublishedShare: (id: string, note?: string) =>
      call<PublishedShare>(`/v1/admin/published-shares/${encodeURIComponent(id)}/remove`, { method: 'POST', body: note ? { note } : {} }),
    /** The quarantined pre-admission relay — readable here, never merged into the feed. */
    legacyShares: () => call<LegacySharePage>('/v1/admin/legacy-shares'),

    // Legacy relay surface (sef1 admin tokens only). Kept for the quarantine drain.
    shares: () => call<AdminShare[]>('/v1/admin/shares'),
    removeShare: (id: string) => call<void>(`/v1/admin/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
