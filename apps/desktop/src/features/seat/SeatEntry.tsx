import { Cloud } from 'lucide-react';
import { useState } from 'react';
import { engineTarget, seatHost, setPreferLocalEngine } from '@/lib/seat';
import { ClaimSeatDialog } from './ClaimSeatDialog';

/** Switch engines. A session token belongs to one engine, so the window reloads onto the other. */
export function switchEngine(toLocal: boolean) {
  setPreferLocalEngine(toLocal);
  window.location.reload();
}

/** The sign-in screen's way into a hosted seat, back out of one, or back to it. */
export function SeatEntry() {
  const [open, setOpen] = useState(false);
  const target = engineTarget();
  // The UI an engine serves itself is already on its seat; there is nothing to claim there.
  if (target.kind === 'served') return null;

  const link = 'cursor-pointer text-night-300 underline underline-offset-2';
  const seat = target.seat;
  if (seat) {
    const host = <span className="font-mono text-night-300">{seatHost(seat.engineUrl) ?? seat.engineUrl}</span>;
    return (
      <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11.5px] text-night-500">
        {target.kind === 'seat' ? (
          <>
            Signing in to your seat at {host}.{' '}
            <button type="button" className={link} onClick={() => switchEngine(true)}>
              Use this computer&apos;s engine instead
            </button>
          </>
        ) : (
          <>
            Using this computer&apos;s engine.{' '}
            <button type="button" className={link} onClick={() => switchEngine(false)}>
              Use your seat at {host}
            </button>
          </>
        )}
      </p>
    );
  }

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-3">
      <button type="button" onClick={() => setOpen(true)} className="flex w-full cursor-pointer items-center gap-2 text-[12.5px] text-night-400 hover:text-night-200">
        <Cloud className="size-3.5 text-beacon-300" />
        Claim your hosted seat
      </button>
      <ClaimSeatDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
