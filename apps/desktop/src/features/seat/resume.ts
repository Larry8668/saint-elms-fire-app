import type { SeatClient } from '@/lib/instabox';

/**
 * "Resume seat": a box that was stopped or paused by hand answers 503 until its owner starts
 * it, and a plain request never wakes it. The desktop shell holds the write-scoped key in the
 * keychain, so it can ask Instabox to bring the box back; a browser tab cannot.
 */
export type ResumeResult =
  /** A start or resume was requested; the engine follows a few seconds after the box boots. */
  | 'requested'
  /** The box is already running or on its way; waiting is enough. */
  | 'already_up'
  /** The machine is deleted or failed; this seat cannot come back. */
  | 'gone';

export async function resumeSeat(
  client: Pick<SeatClient, 'machine' | 'power'>,
  machineId: string,
  newKey: () => string = () => crypto.randomUUID(),
): Promise<ResumeResult> {
  const machine = await client.machine(machineId);
  switch (machine.state) {
    case 'stopped':
      await client.power(machineId, 'start', newKey());
      return 'requested';
    case 'suspended':
      await client.power(machineId, 'resume', newKey());
      return 'requested';
    case 'deleting':
    case 'deleted':
    case 'error':
      return 'gone';
    default:
      return 'already_up';
  }
}
