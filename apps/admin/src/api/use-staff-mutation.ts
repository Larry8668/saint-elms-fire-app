import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { describe } from '@/api/http';
import { useSession } from '@/state/session-context';

/**
 * Staff mutations all fail the same three ways that a form has to handle differently: a stale
 * session (re-authenticate, never silently retry), a stale record (reload, never overwrite) and a
 * refused role. This wrapper lifts the re-auth case into the shell and leaves the rest to the
 * caller, which owns the form and decides what the person sees next.
 *
 * Lives outside `api/queries` so the session context does not have to be imported from there.
 */
export function useStaffMutation<TVars, TData>(
  mutationFn: (variables: TVars) => Promise<TData>,
  options: { onSuccess?: (data: TData, variables: TVars) => void; invalidate?: QueryKey[] } = {},
) {
  const { requireReauth } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (data, variables) => {
      for (const key of options.invalidate ?? []) await client.invalidateQueries({ queryKey: key });
      options.onSuccess?.(data, variables);
    },
    onError: (error) => {
      if (describe(error).kind === 'reauthentication') requireReauth();
    },
  });
}