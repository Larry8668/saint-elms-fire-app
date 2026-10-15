import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TeacherId } from '@sef/shared';
import { toast } from 'sonner';
import { api, type StoredSettings } from './api';

/**
 * Query keys are scoped by profile id. A response that arrives after a sign-out is written
 * into the previous student's bucket, where the next student never reads it — so a late
 * in-flight request can never repopulate the cache across an account switch.
 */
export const keys = {
  /** Engine-wide, not student data: shared by everyone looking at this machine. */
  health: ['health'] as const,
  scoped: {
    settings: (p: string) => ['profile', p, 'settings'] as const,
    sync: (p: string) => ['profile', p, 'sync'] as const,
    library: (p: string) => ['profile', p, 'library'] as const,
    lesson: (p: string, id: string) => ['profile', p, 'lesson', id] as const,
    graph: (p: string) => ['profile', p, 'graph'] as const,
    pages: (p: string) => ['profile', p, 'pages'] as const,
    page: (p: string, key: string) => ['profile', p, 'page', key] as const,
    brainLog: (p: string) => ['profile', p, 'brain-log'] as const,
    lint: (p: string) => ['profile', p, 'lint'] as const,
    sessions: (p: string, teacher: string) => ['profile', p, 'sessions', teacher] as const,
  },
};

/** Used only while signed out, so queries park in a bucket no student session can read. */
const NO_PROFILE = 'signed-out';
let activeProfile: string | null = null;

/** The session provider sets this on activate/clear; it is never client-chosen. */
export const setActiveProfile = (profileId: string | null) => {
  activeProfile = profileId;
};

const profile = () => activeProfile ?? NO_PROFILE;

/** Everything that changes when the brain changes, for the current profile. */
const brainKeys = () => {
  const p = profile();
  return [keys.scoped.graph(p), keys.scoped.pages(p), keys.scoped.brainLog(p), keys.scoped.lint(p), keys.scoped.sessions(p, 'all')];
};

export function useInvalidateBrain() {
  const client = useQueryClient();
  return () => {
    for (const key of brainKeys()) void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['profile', profile(), 'page'] });
  };
}

export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: api.health, refetchInterval: 15_000, retry: false });
export const useSettings = () => useQuery({ queryKey: keys.scoped.settings(profile()), queryFn: api.settings });
export const useSyncStatus = () => useQuery({ queryKey: keys.scoped.sync(profile()), queryFn: api.syncStatus });
export const useLibrary = () => useQuery({ queryKey: keys.scoped.library(profile()), queryFn: api.library });
export const useLesson = (id: string | null) =>
  useQuery({ queryKey: keys.scoped.lesson(profile(), id ?? ''), queryFn: () => api.lesson(id!), enabled: Boolean(id) });
export const useGraph = () => useQuery({ queryKey: keys.scoped.graph(profile()), queryFn: api.graph });
export const usePages = () => useQuery({ queryKey: keys.scoped.pages(profile()), queryFn: api.pages });
export const usePage = (key: string | null) =>
  useQuery({ queryKey: keys.scoped.page(profile(), key ?? ''), queryFn: () => api.page(key!), enabled: Boolean(key), retry: false });
export const useBrainLog = () => useQuery({ queryKey: keys.scoped.brainLog(profile()), queryFn: api.brainLog });
export const useLint = () => useQuery({ queryKey: keys.scoped.lint(profile()), queryFn: api.lint });
export const useSessions = (teacher?: TeacherId) =>
  useQuery({ queryKey: keys.scoped.sessions(profile(), teacher ?? 'all'), queryFn: () => api.sessions(teacher) });

export function useSaveSettings() {
  const client = useQueryClient();
  const settingsKey = keys.scoped.settings(profile());
  return useMutation({
    mutationFn: (patch: Partial<StoredSettings>) => api.saveSettings(patch),
    onSuccess: (settings) => {
      client.setQueryData(settingsKey, settings);
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
      void client.invalidateQueries({ queryKey: keys.scoped.sync(profile()) });
      void client.invalidateQueries({ queryKey: keys.scoped.library(profile()) });
      invalidateBrain();
      toast.success('Courseware verified and installed');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}
