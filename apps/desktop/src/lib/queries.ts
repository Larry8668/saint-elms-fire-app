import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TeacherId } from '@sef/shared';
import { toast } from 'sonner';
import { api, type StoredSettings } from './api';

export const keys = {
  health: ['health'] as const,
  settings: ['settings'] as const,
  sync: ['sync'] as const,
  library: ['library'] as const,
  lesson: (id: string) => ['lesson', id] as const,
  graph: ['graph'] as const,
  pages: ['pages'] as const,
  page: (key: string) => ['page', key] as const,
  brainLog: ['brain-log'] as const,
  lint: ['lint'] as const,
  sessions: ['sessions'] as const,
};

/** Everything that changes when the brain changes. */
const BRAIN_KEYS = [keys.graph, keys.pages, keys.brainLog, keys.lint, keys.sessions];

export function useInvalidateBrain() {
  const client = useQueryClient();
  return () => {
    for (const key of BRAIN_KEYS) void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['page'] });
  };
}

export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: api.health, refetchInterval: 15_000, retry: false });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings });
export const useSyncStatus = () => useQuery({ queryKey: keys.sync, queryFn: api.syncStatus });
export const useLibrary = () => useQuery({ queryKey: keys.library, queryFn: api.library });
export const useLesson = (id: string | null) => useQuery({ queryKey: keys.lesson(id ?? ''), queryFn: () => api.lesson(id!), enabled: Boolean(id) });
export const useGraph = () => useQuery({ queryKey: keys.graph, queryFn: api.graph });
export const usePages = () => useQuery({ queryKey: keys.pages, queryFn: api.pages });
export const usePage = (key: string | null) =>
  useQuery({ queryKey: keys.page(key ?? ''), queryFn: () => api.page(key!), enabled: Boolean(key), retry: false });
export const useBrainLog = () => useQuery({ queryKey: keys.brainLog, queryFn: api.brainLog });
export const useLint = () => useQuery({ queryKey: keys.lint, queryFn: api.lint });
export const useSessions = (teacher?: TeacherId) => useQuery({ queryKey: [...keys.sessions, teacher ?? 'all'], queryFn: () => api.sessions(teacher) });

export function useSaveSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<StoredSettings>) => api.saveSettings(patch),
    onSuccess: (settings) => {
      client.setQueryData(keys.settings, settings);
      void client.invalidateQueries({ queryKey: keys.health });
      toast.success('Settings saved');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useInstallCourses() {
  const client = useQueryClient();
  const invalidateBrain = useInvalidateBrain();
  return useMutation({
    mutationFn: async (courseId: string | 'all'): Promise<void> => {
      if (courseId === 'all') await api.installAll();
      else await api.install(courseId);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sync });
      void client.invalidateQueries({ queryKey: keys.library });
      invalidateBrain();
      toast.success('Courseware verified and installed');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}
