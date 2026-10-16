import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LogisticsWriteInput, TeacherId, WikiJob } from '@sef/shared';
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
    pageRevisions: (p: string, key: string) => ['profile', p, 'page-revisions', key] as const,
    pageRevision: (p: string, key: string, revision: string) => ['profile', p, 'page-revisions', key, revision] as const,
    wikiIndex: (p: string) => ['profile', p, 'wiki-index'] as const,
    wikiPage: (p: string, id: string) => ['profile', p, 'wiki-page', id] as const,
    brainLog: (p: string) => ['profile', p, 'brain-log'] as const,
    lint: (p: string) => ['profile', p, 'lint'] as const,
    sessions: (p: string, teacher: string) => ['profile', p, 'sessions', teacher] as const,
    jobBoard: (p: string) => ['profile', p, 'jobs'] as const,
    source: (p: string, id: string) => ['profile', p, 'source', id] as const,
    sourceBytes: (p: string, id: string) => ['profile', p, 'source-bytes', id] as const,
    proposals: (p: string) => ['profile', p, 'proposals'] as const,
    proposal: (p: string, id: string) => ['profile', p, 'proposal', id] as const,
    logistics: (p: string) => ['profile', p, 'logistics'] as const,
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

/** The bucket every scoped key starts with — for targeted prefix invalidation. */
export const activeProfileKey = () => ['profile', profile()] as const;

/** Everything that changes when the brain changes, for the current profile. */
const brainKeys = () => {
  const p = profile();
  return [
    keys.scoped.graph(p),
    keys.scoped.pages(p),
    keys.scoped.brainLog(p),
    keys.scoped.lint(p),
    keys.scoped.sessions(p, 'all'),
    keys.scoped.jobBoard(p),
    keys.scoped.proposals(p),
    keys.scoped.wikiIndex(p),
  ];
};

export function useInvalidateBrain() {
  const client = useQueryClient();
  return () => {
    for (const key of brainKeys()) void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['profile', profile(), 'page'] });
  };
}

/** One kept source plus the board it moves on — after a correction, a read or a stage change. */
export function useInvalidateSource(id: string) {
  const client = useQueryClient();
  const p = profile();
  return () => {
    void client.invalidateQueries({ queryKey: keys.scoped.source(p, id) });
    void client.invalidateQueries({ queryKey: keys.scoped.jobBoard(p) });
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

/** Terminal stages: a job here never moves again. Anything else is worth polling. */
const JOB_TERMINAL: ReadonlySet<WikiJob['stage']> = new Set(['committed', 'no_changes', 'failed', 'cancelled']);

/**
 * The durable job board. While any job is still moving this polls the engine — the UI
 * shows the stage the journal recorded, never a simulated progress bar.
 */
export const useJobBoard = () =>
  useQuery({
    queryKey: keys.scoped.jobBoard(profile()),
    queryFn: api.jobBoard,
    refetchInterval: (query) => (query.state.data?.jobs.some((job) => !JOB_TERMINAL.has(job.stage)) ? 2_000 : false),
  });
export const useSourceDetail = (id: string | null) =>
  useQuery({ queryKey: keys.scoped.source(profile(), id ?? ''), queryFn: () => api.source(id!), enabled: Boolean(id), retry: false });
export const useSourceBytes = (id: string | null) =>
  useQuery({ queryKey: keys.scoped.sourceBytes(profile(), id ?? ''), queryFn: () => api.sourceBytes(id!), enabled: Boolean(id), staleTime: Infinity, retry: false });
export const useProposals = () => useQuery({ queryKey: keys.scoped.proposals(profile()), queryFn: api.proposals });
export const useProposalPreview = (id: string | null) =>
  useQuery({ queryKey: keys.scoped.proposal(profile(), id ?? ''), queryFn: () => api.proposalPreview(id!), enabled: Boolean(id), retry: false });
export const usePageRevisions = (key: string | null) =>
  useQuery({ queryKey: keys.scoped.pageRevisions(profile(), key ?? ''), queryFn: () => api.pageRevisions(key!), enabled: Boolean(key), retry: false });
export const usePageRevision = (key: string | null, revision: string | null) =>
  useQuery({
    queryKey: keys.scoped.pageRevision(profile(), key ?? '', revision ?? ''),
    queryFn: () => api.pageRevision(key!, revision!),
    enabled: Boolean(key && revision),
    retry: false,
  });
export const useWikiIndex = () => useQuery({ queryKey: keys.scoped.wikiIndex(profile()), queryFn: api.wikiIndex });
export const useWikiPage = (id: string | null) =>
  useQuery({ queryKey: keys.scoped.wikiPage(profile(), id ?? ''), queryFn: () => api.wikiPage(id!), enabled: Boolean(id), retry: false });

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

/** The student's private logistics ledger — scoped to the profile like everything else it owns. */
export const useLogistics = () => useQuery({ queryKey: keys.scoped.logistics(profile()), queryFn: api.logistics });

export function useCreateLogistics() {
  const client = useQueryClient();
  const key = keys.scoped.logistics(profile());
  return useMutation({
    mutationFn: (body: LogisticsWriteInput) => api.createLogistics(body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key });
      toast.success('Logistics record saved');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useUpdateLogistics() {
  const client = useQueryClient();
  const key = keys.scoped.logistics(profile());
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<LogisticsWriteInput> }) => api.updateLogistics(id, patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useConfirmLogistics() {
  const client = useQueryClient();
  const key = keys.scoped.logistics(profile());
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch?: Partial<LogisticsWriteInput> }) => api.confirmLogistics(id, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key });
      toast.success('Confirmed — the Friend can now draw on it');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useDismissLogistics() {
  const client = useQueryClient();
  const key = keys.scoped.logistics(profile());
  return useMutation({
    mutationFn: (id: string) => api.dismissLogistics(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useDeleteLogistics() {
  const client = useQueryClient();
  const key = keys.scoped.logistics(profile());
  return useMutation({
    mutationFn: (id: string) => api.deleteLogistics(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key });
      toast.success('Record deleted');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useExtractLogistics() {
  const client = useQueryClient();
  const key = keys.scoped.logistics(profile());
  return useMutation({
    mutationFn: ({ image, note }: { image: { mimeType: 'image/png' | 'image/jpeg'; data: string }; note?: string }) => api.extractLogistics(image, note),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: key });
      toast.success(result.items.length ? `${result.items.length} proposal${result.items.length === 1 ? '' : 's'} read — confirm below` : 'Read the photo — nothing schedule-like found');
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
