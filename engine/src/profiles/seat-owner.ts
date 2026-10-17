import path from 'node:path';
import { config, log } from '../config';
import { parsePublicHost } from '../http/edge';
import { readJson, writeFileExclusive } from '../lib/fs';
import type { AuthSessions } from './sessions';

/**
 * Who a hosted seat belongs to.
 *  - local:    not hosted. No owner, no check: several profiles share the device as before.
 *  - owner:    the uni account ids allowed to sign in, from ENGINE_SEAT_OWNER or the pin file.
 *  - unpinned: hosted, nobody pinned yet. The first uni-verified sign-in becomes the owner.
 *  - corrupt:  the pin file exists but cannot be read. Fails closed: nobody signs in.
 */
export type SeatState =
  | { kind: 'local' }
  | { kind: 'owner'; ids: ReadonlySet<string>; source: 'env' | 'pin' }
  | { kind: 'unpinned' }
  | { kind: 'corrupt' };

interface PinFile {
  accountId: string;
  pinnedAt: string;
}

export interface SeatOwnerOptions {
  hosted: boolean;
  /** ENGINE_SEAT_OWNER: one uni account id, or several comma-separated. Wins over the pin file. */
  envOwner?: string;
  file?: string;
}

export const seatOwnerFile = () => path.join(config.paths.data, 'seat-owner.json');

/**
 * Pins a hosted seat to one student. Every sign-in path asks `claim` (uni-verified, may pin)
 * or `allows` (no pinning) with the uni account id before anything of that account is written.
 */
export class SeatOwner {
  private state: SeatState | null = null;
  /** Serialises first-use pinning, so two concurrent first sign-ins cannot both win. */
  private lock: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly options: SeatOwnerOptions) {
    this.file = options.file ?? seatOwnerFile();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SeatOwner {
    return new SeatOwner({ hosted: parsePublicHost(env.ENGINE_PUBLIC_HOST) !== null, envOwner: env.ENGINE_SEAT_OWNER });
  }

  async load(): Promise<SeatState> {
    if (this.state) return this.state;
    if (!this.options.hosted) return (this.state = { kind: 'local' });
    const fromEnv = (this.options.envOwner ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    if (fromEnv.length > 0) return (this.state = { kind: 'owner', ids: new Set(fromEnv), source: 'env' });
    try {
      const pin = await readJson<PinFile | null>(this.file, null);
      if (pin === null) return (this.state = { kind: 'unpinned' });
      if (typeof pin?.accountId !== 'string' || !pin.accountId) throw new Error('no accountId');
      return (this.state = { kind: 'owner', ids: new Set([pin.accountId]), source: 'pin' });
    } catch (error) {
      log.error('seat_owner_unreadable', { file: this.file, error: (error as Error).message });
      return (this.state = { kind: 'corrupt' });
    }
  }

  /** The owner ids, or null when there is none to compare with (local, unpinned, corrupt). */
  async owners(): Promise<ReadonlySet<string> | null> {
    const state = await this.load();
    return state.kind === 'owner' ? state.ids : null;
  }

  /** May this account use the seat? Never pins: for paths the uni did not just verify. */
  async allows(accountId: string): Promise<boolean> {
    const state = await this.load();
    if (state.kind === 'local') return true;
    if (state.kind === 'owner') return state.ids.has(accountId);
    if (state.kind === 'corrupt') log.error('seat_owner_unreadable_refused', { file: this.file });
    return false;
  }

  /** Same check for an account the uni has just verified; the first one on an unpinned seat is pinned. */
  claim(accountId: string): Promise<boolean> {
    const run = this.lock.then(async () => {
      const state = await this.load();
      if (state.kind !== 'unpinned') return this.allows(accountId);
      const pin: PinFile = { accountId, pinnedAt: new Date().toISOString() };
      try {
        await writeFileExclusive(this.file, JSON.stringify(pin, null, 2));
      } catch (error) {
        // Another engine process pinned first: re-read and go by its answer.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.state = null;
        return this.allows(accountId);
      }
      this.state = { kind: 'owner', ids: new Set([accountId]), source: 'pin' };
      log.info('seat_owner_pinned', { accountId, file: this.file });
      return true;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Session resolution: unpinned seats keep earlier sessions until a pin exists; a corrupt pin honours none. */
  async allowsSession(profileId: string): Promise<boolean> {
    const state = await this.load();
    if (state.kind === 'local' || state.kind === 'unpinned') return true;
    return state.kind === 'owner' && state.ids.has(profileId);
  }
}

/**
 * Boot-time sweep on a hosted seat: says who owns it, and revokes sessions other profiles
 * were issued before the pin existed. A corrupt pin is logged loudly; nothing is deleted
 * (the owner is unknown), and session resolution refuses everyone until it is fixed.
 */
export async function enforceSeatOwner(seat: SeatOwner, sessions: AuthSessions): Promise<SeatState> {
  const state = await seat.load();
  if (state.kind === 'local') return state;
  if (state.kind === 'corrupt') {
    log.error('seat_owner_fail_closed', { reason: 'The seat-owner pin is unreadable: every sign-in is refused. See docs/hosted-seat.md to reset it.' });
    return state;
  }
  if (state.kind === 'unpinned') {
    log.info('seat_owner_unpinned', { note: 'The next uni-verified sign-in pins this seat.' });
    return state;
  }
  const revoked = await sessions.revokeUnless((profileId) => state.ids.has(profileId));
  log.info('seat_owner_enforced', { source: state.source, owners: [...state.ids], revokedSessions: revoked });
  return state;
}
