import { useQuery } from '@tanstack/react-query';
import * as api from '@/api/admin-api';
import { getAuthSession } from '@/api/session';

/**
 * Query keys are scoped per account: a sign-out must never leave another staff member's
 * records in the cache.
 */
export const keys = {
  auth: ['auth-session'] as const,
  students: (query: api.StudentQuery) => ['students', query] as const,
  student: (profileId: string) => ['student', profileId] as const,
  staff: ['staff'] as const,
  erasures: ['erasures'] as const,
  audit: ['audit'] as const,
  cohorts: ['cohorts'] as const,
};

export function useSessionProbe() {
  return useQuery({
    queryKey: keys.auth,
    queryFn: async () => {
      const auth = await getAuthSession();
      if (!auth) return null;
      // Staff authority is server-derived: the roles on `/v1/me` are what the shell trusts.
      const me = await api.fetchMe();
      return { auth, me };
    },
    retry: false,
    staleTime: 30_000,
  });
}

export const useStudents = (query: api.StudentQuery) =>
  useQuery({ queryKey: keys.students(query), queryFn: () => api.listStudents(query), placeholderData: (prev) => prev });

export const useStudent = (profileId: string | null) =>
  useQuery({ queryKey: keys.student(profileId ?? ''), queryFn: () => api.getStudent(profileId!), enabled: Boolean(profileId) });

export const useStaffList = () => useQuery({ queryKey: keys.staff, queryFn: api.listStaff });

export const useErasureRequests = () => useQuery({ queryKey: keys.erasures, queryFn: api.listErasureRequests });

export const useAuditEvents = (limit: number) =>
  useQuery({ queryKey: [...keys.audit, limit], queryFn: () => api.listAuditEvents(limit) });

export const useCohorts = () => useQuery({ queryKey: keys.cohorts, queryFn: api.listCohorts, staleTime: 5 * 60_000 });
