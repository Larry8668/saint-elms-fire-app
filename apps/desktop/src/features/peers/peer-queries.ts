import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShareDraftRequest } from '@sef/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useStudent } from '@/lib/session';
import { keys, useInvalidateBrain } from '@/lib/queries';

const useProfileId = () => useStudent().profile.id;

export const useSharePages = () => {
  const pid = useProfileId();
  return useQuery({ queryKey: ['profile', pid, 'share-pages'], queryFn: api.sharePages });
};

export const useSourceList = () => {
  const pid = useProfileId();
  return useQuery({ queryKey: ['profile', pid, 'sources'], queryFn: api.jobBoard });
};

/** Cursor-paginated cohort feed; `fetchNextPage` walks the server's opaque cursor. */
export const usePeerFeed = () => {
  const pid = useProfileId();
  return useInfiniteQuery({
    queryKey: ['profile', pid, 'peer-feed'],
    queryFn: ({ pageParam }) => api.peerFeed(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // The feed's first page decides the banner state; refetching is cheap and manual.
    refetchOnWindowFocus: false,
  });
};

export const useOwnShares = () => {
  const pid = useProfileId();
  return useQuery({ queryKey: ['profile', pid, 'own-shares'], queryFn: api.ownShares });
};

function usePeerInvalidation() {
  const client = useQueryClient();
  const pid = useProfileId();
  return () => {
    void client.invalidateQueries({ queryKey: ['profile', pid, 'peer-feed'] });
    void client.invalidateQueries({ queryKey: ['profile', pid, 'own-shares'] });
    void client.invalidateQueries({ queryKey: keys.scoped.pages(pid) });
  };
}

export function usePrepareShare() {
  return useMutation({
    mutationFn: (input: ShareDraftRequest) => api.prepareShare(input),
    onError: (error) => toast.error((error as Error).message),
  });
}

export function usePublishShare() {
  const invalidate = usePeerInvalidation();
  return useMutation({
    mutationFn: api.publishShare,
    onSuccess: (result) => {
      invalidate();
      toast.success(result.replayed ? 'Already published — the university replayed your earlier share.' : `Published “${result.share.payload.title}” to cohort ${result.share.cohortId}.`);
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useWithdrawShare() {
  const invalidate = usePeerInvalidation();
  return useMutation({
    mutationFn: (id: string) => api.withdrawShare(id),
    onSuccess: () => {
      invalidate();
      toast.success('Share withdrawn. Classmates who already imported it keep their copy.');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useIgnoreShare() {
  const invalidate = usePeerInvalidation();
  return useMutation({
    mutationFn: ({ id, ignored }: { id: string; ignored: boolean }) => api.ignoreShare(id, ignored),
    onSuccess: (_r, { ignored }) => {
      invalidate();
      toast.success(ignored ? 'Hidden from your feed.' : 'Back in your feed.');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useImportShare() {
  const invalidate = usePeerInvalidation();
  return useMutation({
    mutationFn: (id: string) => api.importShare(id),
    onError: (error) => toast.error((error as Error).message),
  });
}

export function useDecideProposal() {
  const invalidate = usePeerInvalidation();
  const invalidateBrain = useInvalidateBrain();
  return useMutation({
    mutationFn: async ({ id, decision, note }: { id: string; decision: 'accept' | 'reject'; note?: string }) =>
      decision === 'accept' ? api.acceptProposal(id) : api.rejectProposal(id, note),
    onSuccess: (_r, { decision }) => {
      invalidate();
      invalidateBrain();
      toast.success(decision === 'accept' ? 'Added to your brain.' : 'Proposal rejected — nothing was written.');
    },
    onError: (error) => toast.error((error as Error).message),
  });
}
