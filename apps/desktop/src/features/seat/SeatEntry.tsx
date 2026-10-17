import { Cloud } from 'lucide-react';
import { useState } from 'react';
import { ENGINE_URL } from '@/lib/api';
import { forgetSeat, readSeat } from '@/lib/seat';
import { ClaimSeatDialog } from './ClaimSeatDialog';

/** The sign-in screen's way into a hosted seat, or back out of one. */
export function SeatEntry() {
  const [open, setOpen] = useState(false);
  const seat = readSeat();
  // The UI an engine serves itself is already on its seat; there is nothing to claim there.
  if (ENGINE_URL === '') return null;

  if (seat) {
    return (
      <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11.5px] text-night-500">
        Signing in to your seat at <span className="font-mono text-night-300">{new URL(seat.engineUrl).host}</span>.{' '}
        <button
          type="button"
          className="cursor-pointer text-night-300 underline underline-offset-2"
          onClick={() => {
            forgetSeat();
            window.location.reload();
          }}
        >
          Use this computer&apos;s engine instead
        </button>
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
