import { useCallback, useState } from 'react';
import { log } from '@/lib/log';
import { PortalError } from './portal-api';

/**
 * One place where a busy flag is set and every failure becomes a message the student sees.
 * `PortalError` already carries mapped copy; anything else is unexpected and is logged by
 * shape only — never the request, which holds a password or a reset token.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PortalError | null>(null);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setError(null);
      setBusy(true);
      try {
        await action();
      } catch (caught) {
        if (caught instanceof PortalError) {
          setError(caught);
        } else {
          log.error('portal_unexpected_error', { name: caught instanceof Error ? caught.name : 'unknown' });
          setError(new PortalError('Something went wrong in this app. Reload the page and try again.', 0, 'unexpected'));
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { busy, error, setError, run };
}