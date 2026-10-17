import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, PauseCircle, Play, RotateCcw } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { cn } from '@/lib/cn';
import { createSeatClient, inTauri, SeatError } from '@/lib/instabox';
import { log } from '@/lib/log';
import { engineTarget, isRemoteTarget, seatHost } from '@/lib/seat';
import { seatWaker, wakeNoticeOf, type WakeState } from '@/lib/seat-wake';
import { describeFailure } from './claim';
import { resumeSeat } from './resume';

export const useSeatWake = (): WakeState => useSyncExternalStore(seatWaker.subscribe, () => seatWaker.state);

/**
 * The hosted seat's own state, in place of the local "engine isn't running" message. `failed`
 * says a call already gave up (the sign-in screen's health check) while the waker is idle.
 */
export function SeatWakeNotice({ failed = false, className }: { failed?: boolean; className?: string }) {
  const state = useSeatWake();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target = engineTarget();
  const notice = wakeNoticeOf(state, failed);
  if (!isRemoteTarget(target) || notice === null) return null;

  const base = target.base;
  const host = target.kind === 'seat' ? seatHost(base) : typeof location === 'undefined' ? null : location.host;
  const machineId = target.kind === 'seat' ? target.seat.machineId : undefined;
  const since = state.phase === 'waking' ? state.since : undefined;

  const retry = async () => {
    setProblem(null);
    if ((await seatWaker.wake(base, 'network')) === 'ready') void queryClient.invalidateQueries();
  };

  const resume = async () => {
    if (!machineId) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await resumeSeat(createSeatClient(), machineId);
      log.info('seat_resume', { result });
      if (result === 'gone') {
        setProblem('This seat machine was deleted or failed in Instabox. Claim a new seat, then restore your vault export.');
        return;
      }
      seatWaker.extend();
      if ((await seatWaker.wake(base, 'starting')) === 'ready') void queryClient.invalidateQueries();
    } catch (error) {
      const code = error instanceof SeatError ? error.code : 'shell_unavailable';
      log.warn('seat_resume_failed', { code });
      setProblem(code === 'key_missing' ? 'This computer has no Instabox key saved. Resume the machine in the Instabox dashboard.' : describeFailure(code, 'Could not resume your seat.'));
    } finally {
      setBusy(false);
    }
  };

  const box = cn('rounded-2xl border p-4 text-[13px] leading-6', className);

  if (notice === 'waking' || notice === 'starting') {
    return (
      <div role="status" className={cn(box, 'border-beacon-400/20 bg-beacon-500/[0.06] text-night-200')}>
        <WorkingLabel label="Waking your seat…" startedAt={since} />
        <p className="mt-1 text-[12.5px] text-night-400">
          {notice === 'starting' ? 'The machine is up; the engine is still starting.' : `Reaching ${host ?? 'your seat'}. An idle seat usually answers within a few seconds.`}
        </p>
      </div>
    );
  }

  if (notice === 'paused') {
    const canResume = inTauri() && Boolean(machineId);
    return (
      <div role="alert" className={cn(box, 'border-ember-400/25 bg-ember-400/[0.07] text-night-200')}>
        <p className="flex items-center gap-2 font-medium text-night-100">
          <PauseCircle className="size-4 text-ember-300" /> Your seat is paused
        </p>
        {canResume ? (
          <p className="mt-1 text-[12.5px] text-night-400">It was stopped or paused, so requests alone cannot wake it. Resuming takes a few seconds, then the engine starts.</p>
        ) : (
          <p className="mt-1 text-[12.5px] text-night-400">
            It was stopped or paused, and a web page cannot start it. Resume it from the Saint Elms Fire desktop app (Settings, Your seat) or in the Instabox dashboard;
            this page carries on once it answers.
          </p>
        )}
        {problem && <p className="mt-2 text-[12.5px] text-rose-300">{problem}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {canResume && (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void resume()}>
              <Play /> Resume seat
            </Button>
          )}
          {state.phase !== 'waking' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retry()}>
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
        <CloudOff className="size-4 text-night-400" /> Can&apos;t reach your seat
      </p>
      <p className="mt-1 text-[12.5px] text-night-400">
        {host ?? 'Your seat'} did not answer for a minute. A hosted seat needs a network connection; check yours, then try again.
      </p>
      <Button size="sm" variant="ghost" className="mt-3" onClick={() => void retry()}>
        <RotateCcw /> Try again
      </Button>
    </div>
  );
}
