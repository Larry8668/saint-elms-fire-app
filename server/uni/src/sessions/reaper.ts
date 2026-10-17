import type { Pool } from 'pg';
import { LIVE_SESSION_STATES } from '@sef/shared';
import { InstaboxError, isMachineId, type InstaboxClient } from '../instabox/client';
import { errorFields, log } from '../logger';
import { SESSION_APP_LABEL, type SessionOrchestrator } from './orchestrator';
import { idleSessions, newIdempotencyKey, sessionsInState } from './store';

/**
 * The idle reaper, an interval inside the uni process. Each tick:
 *  1. a session with no heartbeat for SESSION_IDLE_MINUTES, or whose lease ran out, is ended
 *     (stopping → session-stop.sh flush → delete → ended);
 *  2. spawns and teardowns no one in this process is driving (after a restart) are resumed,
 *     and free slots are filled from the queue;
 *  3. the orphan sweep deletes machines labelled `app:sef-session` that no live row owns.
 * Nothing here can reach a machine without that label: every id it acts on comes from a
 * labelled listing (re-checked here) or from a session row the orchestrator created.
 */
export class SessionReaper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly orchestrator: SessionOrchestrator,
    private readonly pool: Pool,
    private readonly client: InstaboxClient,
  ) {}

  start(intervalMs = this.orchestrator.config.reaperIntervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One pass. Overlapping ticks join the one in flight. */
  tick(): Promise<void> {
    this.running ??= this.pass()
      .catch((error) => log.error('session_reaper_failed', errorFields(error)))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(): Promise<void> {
    const idleMinutes = this.orchestrator.config.idleMinutes;
    for (const row of await idleSessions(this.pool, idleMinutes)) {
      const reason = row.heartbeat_at.getTime() < Date.now() - idleMinutes * 60_000 ? 'idle' : 'lease_expired';
      log.info('session_idle', { sessionId: row.id, state: row.state, reason, heartbeatAt: row.heartbeat_at.toISOString() });
      await this.orchestrator.forceEnd(row.id, reason);
    }
    for (const row of await sessionsInState(this.pool, ['spawning'])) if (!this.orchestrator.busy(row.id)) void this.orchestrator.drive(row.id);
    for (const row of await sessionsInState(this.pool, ['stopping'])) if (!this.orchestrator.busy(row.id)) void this.orchestrator.teardown(row.id);
    await this.orchestrator.promoteAndDrive();
    await this.sweepOrphans();
  }

  /** Deletes labelled session machines that no live row owns. Returns the ids it deleted. */
  async sweepOrphans(): Promise<string[]> {
    const machines = await this.client.listMachines({ app: SESSION_APP_LABEL });
    const live = await sessionsInState(this.pool, LIVE_SESSION_STATES);
    const ownedMachines = new Set(live.map((row) => row.machine_id).filter(Boolean));
    const liveSessions = new Set(live.map((row) => row.id));
    const deleted: string[] = [];
    for (const machine of machines) {
      // The listing filter is Instabox's; the label is checked again before anything is touched.
      if (machine.metadata?.app !== SESSION_APP_LABEL || !isMachineId(machine.id)) continue;
      if (ownedMachines.has(machine.id)) continue;
      // A spawn may have created it a moment ago and not yet written the id to its row.
      if (machine.metadata.session && liveSessions.has(machine.metadata.session)) continue;
      if (machine.state === 'deleting' || machine.state === 'deleted') continue;
      try {
        await this.client.deleteMachine(machine.id, newIdempotencyKey(machine.id, 'orphan'));
        deleted.push(machine.id);
        log.warn('session_orphan_deleted', { machineId: machine.id, session: machine.metadata.session ?? null, state: machine.state });
      } catch (error) {
        log.error('session_orphan_delete_failed', { machineId: machine.id, code: error instanceof InstaboxError ? error.code : 'internal' });
      }
    }
    return deleted;
  }
}
