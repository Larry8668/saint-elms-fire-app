import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { activeProfileKey, keys, useInvalidateBrain } from '@/lib/queries';
import { installSequentially, resultSummary, type InstallAllResult, type InstallProgress, type InstallTarget } from './install-all';

/**
 * "Download all", one course per request. Progress and the last run's result live here so
 * the Library can show "Installing 7 of 21…" and, afterwards, which courses did not install.
 */
export function useInstallAll() {
  const client = useQueryClient();
  const invalidateBrain = useInvalidateBrain();
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [result, setResult] = useState<InstallAllResult | null>(null);
  const mutation = useMutation({
    mutationFn: (courses: InstallTarget[]) => {
      setResult(null);
      return installSequentially(courses, (id) => api.install(id), setProgress);
    },
    onSuccess: (outcome) => {
      setResult(outcome);
      const message = resultSummary(outcome);
      if (outcome.failed.length) toast.error(message);
      else toast.success(message);
    },
    onError: (error) => toast.error((error as Error).message),
    onSettled: () => {
      setProgress(null);
      const p = activeProfileKey()[1];
      void client.invalidateQueries({ queryKey: keys.scoped.sync(p) });
      void client.invalidateQueries({ queryKey: keys.scoped.library(p) });
      invalidateBrain();
    },
  });
  return { run: mutation.mutate, isPending: mutation.isPending, progress, result, dismiss: () => setResult(null) };
}
