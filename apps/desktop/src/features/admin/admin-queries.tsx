import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountPatch, CohortSummary, NewAccount } from '@sef/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { AdminApi } from './admin-api';

const AdminApiContext = createContext<AdminApi | null>(null);

export function AdminApiProvider({ api, children }: { api: AdminApi; children: ReactNode }) {
  return <AdminApiContext.Provider value={api}>{children}</AdminApiContext.Provider>;
}

export function useAdminApi(): AdminApi {
  const api = useContext(AdminApiContext);
  if (!api) throw new Error('useAdminApi must be used inside AdminApiProvider');
  return api;
}

export const adminKeys = {
  all: ['admin'] as const,
  overview: ['admin', 'overview'] as const,
  cohorts: ['admin', 'cohorts'] as const,
  courses: ['admin', 'courses'] as const,
  lessons: (id: string) => ['admin', 'lessons', id] as const,
  accounts: ['admin', 'accounts'] as const,
  dispersal: ['admin', 'dispersal'] as const,
  audit: ['admin', 'audit'] as const,
  shares: ['admin', 'shares'] as const,
  publishedShares: (filters: { cohort?: string; state?: string }) => ['admin', 'published-shares', filters] as const,
  publishedShare: (id: string) => ['admin', 'published-share', id] as const,
  legacyShares: ['admin', 'legacy-shares'] as const,
};

export const useOverview = () => useQuery({ queryKey: adminKeys.overview, queryFn: useAdminApi().overview });
export const useCohorts = () => useQuery({ queryKey: adminKeys.cohorts, queryFn: useAdminApi().cohorts });
export const useAdminCourses = () => useQuery({ queryKey: adminKeys.courses, queryFn: useAdminApi().courses });
export const useAccounts = () => useQuery({ queryKey: adminKeys.accounts, queryFn: useAdminApi().accounts });
export const useDispersal = () => useQuery({ queryKey: adminKeys.dispersal, queryFn: useAdminApi().dispersal });
export function useAudit() {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.audit, queryFn: () => api.audit() });
}
export const useShares = () => useQuery({ queryKey: adminKeys.shares, queryFn: useAdminApi().shares });

/** Cursor-paginated published-share moderation list; `cursor` is the server's opaque keyset token. */
export function usePublishedShares(filters: { cohort?: string; state?: 'published' | 'withdrawn' }) {
  const api = useAdminApi();
  return useInfiniteQuery({
    queryKey: adminKeys.publishedShares(filters),
    queryFn: ({ pageParam }) => api.publishedShares({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function usePublishedShare(id: string | null) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.publishedShare(id ?? ''), queryFn: () => api.publishedShare(id!), enabled: Boolean(id) });
}

export const useLegacyShares = () => useQuery({ queryKey: adminKeys.legacyShares, queryFn: useAdminApi().legacyShares });

export function useLessons(courseId: string | null) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.lessons(courseId ?? ''), queryFn: () => api.lessons(courseId!), enabled: Boolean(courseId) });
}

/** Most admin writes touch several views (overview, audit, the edited list), so refresh them all. */
function useAdminMutation<TVars, TResult>(fn: (api: AdminApi, vars: TVars) => Promise<TResult>, success?: (result: TResult, vars: TVars) => string) {
  const api = useAdminApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => fn(api, vars),
    onSuccess: (result, vars) => {
      void client.invalidateQueries({ queryKey: adminKeys.all });
      const message = success?.(result, vars);
      if (message) toast.success(message);
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useSetReleased() {
  const api = useAdminApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { cohortId: string; courseIds: string[]; released: boolean }) => api.setReleased(vars.cohortId, vars.courseIds, vars.released),
    // Optimistic: toggles should feel instant; roll back if the server refuses.
    onMutate: async ({ cohortId, courseIds, released }) => {
      await client.cancelQueries({ queryKey: adminKeys.cohorts });
      const previous = client.getQueryData<CohortSummary[]>(adminKeys.cohorts);
      client.setQueryData<CohortSummary[]>(adminKeys.cohorts, (rows) =>
        rows?.map((c) => {
          // A '*' cohort has everything released; leave it to the server's answer.
          if (c.id !== cohortId || c.courses.includes('*')) return c;
          const set = new Set(c.courses);
          for (const id of courseIds) released ? set.add(id) : set.delete(id);
          return { ...c, courses: [...set] };
        }),
      );
      return { previous };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) client.setQueryData(adminKeys.cohorts, ctx.previous);
      toast.error((error as Error).message);
    },
    onSuccess: (_r, { courseIds, released }) => toast.success(`${courseIds.length} course${courseIds.length === 1 ? '' : 's'} ${released ? 'released' : 'withdrawn'}`),
    onSettled: () => void client.invalidateQueries({ queryKey: adminKeys.all }),
  });
}

export const useCreateCohort = () =>
  useAdminMutation((api, input: { id: string; name: string; copyFrom?: string }) => api.createCohort(input), (c) => `Cohort ${c.id} created`);
export const useCreateAccount = () => useAdminMutation((api, input: NewAccount) => api.createAccount(input), (a) => `${a.name} can now sign in`);
export const useUpdateAccount = () =>
  useAdminMutation((api, { id, patch }: { id: string; patch: AccountPatch }) => api.updateAccount(id, patch), (a, { patch }) => (patch.password ? `Password reset for ${a.name}` : `${a.name} updated`));
export const useRemoveShare = () => useAdminMutation((api, id: string) => api.removeShare(id), () => 'Share removed from the relay');
export const useRemovePublishedShare = () =>
  useAdminMutation((api, { id, note }: { id: string; note?: string }) => api.removePublishedShare(id, note), () => 'Share removed from the cohort feed');

