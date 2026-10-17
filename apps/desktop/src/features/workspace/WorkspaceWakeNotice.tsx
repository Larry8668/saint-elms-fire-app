import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, PowerOff, RotateCcw } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { cn } from '@/lib/cn';
import { currentEngineTarget, isRemoteTarget } from '@/lib/seat';
import { seatWaker, wakeNoticeOf, type WakeState } from '@/lib/seat-wake';
import { portalUrl } from '@/lib/uni-url';

export const useWorkspaceWake = (): WakeState => useSyncExternalStore(seatWaker.subscribe, () => seatWaker.state);

/**
 * A hosted workspace's edge state, in place of the local "engine isn't running" message.
 * `failed` says a call already gave up (the sign-in screen's health check) while the waker is idle.
 */
export function WorkspaceWakeNotice({ failed = false, className }: { failed?: boolean; className?: string }) {
  const state = useWorkspaceWake();
  const queryClient = useQueryClient();
  const target = currentEngineTarget();
  const notice = wakeNoticeOf(state, failed);
  if (!isRemoteTarget(target) || notice === null) return null;

  const since = state.phase === 'waking' ? state.since : undefined;
  const retry = async () => {
    if ((await seatWaker.wake(target.base, 'network')) === 'ready') void queryClient.invalidateQueries();
  };
  const box = cn('rounded-2xl border p-4 text-[13px] leading-6', className);

  if (notice === 'waking' || notice === 'starting') {
    return (
      <div role="status" className={cn(box, 'border-beacon-400/20 bg-beacon-500/[0.06] text-night-200')}>
        <WorkingLabel label="Reconnecting to your workspace…" startedAt={since} />
        <p className="mt-1 text-[12.5px] text-night-400">
          {notice === 'starting' ? 'The machine is up; the study engine is still starting.' : 'The connection dropped. An idle workspace usually answers within a few seconds.'}
        </p>
      </div>
    );
  }

  if (notice === 'offline') {
    return (
      <div role="alert" className={cn(box, 'border-ember-400/25 bg-ember-400/[0.07] text-night-200')}>
        <p className="flex items-center gap-2 font-medium text-night-100">
          <PowerOff className="size-4 text-ember-300" /> Your workspace is offline
        </p>
        <p className="mt-1 text-[12.5px] text-night-400">
          Workspaces end after a period without use, and your notes are saved to your university storage when they do. Open a new one from the university portal.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={portalUrl()} className="inline-flex items-center rounded-xl bg-beacon-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-beacon-400">
            Go to the portal
          </a>
          {state.phase !== 'waking' && (
            <Button size="sm" variant="ghost" onClick={() => void retry()}>
              <RotateCcw /> Check again
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className={cn(box, 'border-white/[0.08] bg-white/[0.03] text-night-200')}>
      <p className="flex items-center gap-2 font-medium text-night-100">
        <CloudOff className="size-4 text-night-400" /> Can&apos;t reach your workspace
      </p>
      <p className="mt-1 text-[12.5px] text-night-400">It did not answer for a minute. A hosted workspace needs a network connection; check yours, then try again.</p>
      <Button size="sm" variant="ghost" className="mt-3" onClick={() => void retry()}>
        <RotateCcw /> Try again
      </Button>
    </div>
  );
}
