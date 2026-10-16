import { LogOut, RefreshCw, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/primitives';
import { admissionCopy, mayEnterDashboard, type AdmissionState } from './admission';
import { portalUrl } from '@/lib/uni-url';

/**
 * Stands between a signed-in student and the dashboard when the university has not
 * approved them. The state is server-derived, so this screen never guesses: anything
 * other than an approval (or a legacy profile) is shown as-is, with no way to skip past.
 * Suspended and withdrawn enrolments rarely get here — a fresh sign-in is a limited
 * session that Root routes to the limited-access screen — but a session issued before
 * the enrolment changed still lands on this gate.
 */
export function AdmissionGate({ state, onRefresh, onSignOut, refreshing }: { state: AdmissionState; onRefresh: () => void; onSignOut: () => void; refreshing: boolean }) {
  // Defence in depth: the engine already refuses data routes, so this should be unreachable.
  if (mayEnterDashboard(state)) return null;

  const copy = admissionCopy(state);
  const canRetry = state === 'pending';

  return (
    <div className="sky-backdrop relative grid min-h-screen place-items-center overflow-y-auto px-6 py-12">
      <section className="glass-strong animate-rise w-full max-w-md rounded-3xl p-7 text-center">
        <EmptyState
          icon={<ShieldQuestion />}
          title={copy.title}
          body={copy.body}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {canRetry && (
                <Button onClick={onRefresh} loading={refreshing}>
                  <RefreshCw className="size-4" /> Check again
                </Button>
              )}
              {copy.action && (
                <a href={portalUrl()} target="_blank" rel="noreferrer noopener" className="text-[13px] text-beacon-300 underline underline-offset-4">
                  {copy.action}
                </a>
              )}
            </div>
          }
        />
        <Button variant="ghost" onClick={onSignOut} className="mt-6">
          <LogOut className="size-4" /> Sign out
        </Button>
      </section>
    </div>
  );
}
