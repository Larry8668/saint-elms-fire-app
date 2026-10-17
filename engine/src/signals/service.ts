import { CONTRACT_VERSION, type AttentionResponse, type PeerFeedResponse, type ProactivitySettings, type SyncStatus } from '@sef/shared';
import { errorFields, log } from '../config';
import { DETECTORS, type DetectedSignal, type Detector, type SignalInputs } from './detectors';
import { attentionView, URGENCY_RANK } from './policy';
import type { SignalLedger, SignalStore, StoredSignal } from './store';

export const STALE_AFTER_MS = 5 * 60_000;
export const MAX_SIGNALS = 200;
const TOUCH_DEBOUNCE_MS = 500;

export interface SignalServiceDeps {
  store: SignalStore;
  /** Reads existing stores only; a source that fails is left undefined, not empty. */
  inputs: () => Promise<Omit<SignalInputs, 'now' | 'observations'>>;
  proactivity: () => Promise<ProactivitySettings>;
  now?: () => Date;
  detectors?: readonly Detector[];
}

export type SignalActionResult = 'ok' | 'not_found';

function sameContent(a: StoredSignal, b: DetectedSignal): boolean {
  return a.title === b.title && a.detail === b.detail && a.urgency === b.urgency && a.dueAt === b.dueAt && a.entityRefs.join() === b.entityRefs.join();
}

function merge(previous: StoredSignal | undefined, found: DetectedSignal, at: string, nowMs: number): StoredSignal {
  if (!previous) return { ...found, state: 'new', createdAt: at, updatedAt: at };
  const escalated = URGENCY_RANK[found.urgency] > URGENCY_RANK[previous.urgency];
  const snoozedUntil = previous.snoozedUntil && Date.parse(previous.snoozedUntil) > nowMs ? previous.snoozedUntil : undefined;
  return {
    ...found,
    createdAt: previous.createdAt,
    updatedAt: sameContent(previous, found) ? previous.updatedAt : at,
    // A seen item that becomes more urgent is new again; a dismissal always sticks.
    state: previous.state === 'seen' && escalated ? 'new' : previous.state,
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };
}

/** Keeps the most urgent, most recent items when the ledger outgrows its cap. */
function capped(items: Record<string, StoredSignal>): Record<string, StoredSignal> {
  const list = Object.values(items);
  if (list.length <= MAX_SIGNALS) return items;
  list.sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || b.updatedAt.localeCompare(a.updatedAt));
  return Object.fromEntries(list.slice(0, MAX_SIGNALS).map((item) => [item.key, item]));
}

/**
 * Per-workspace signal evaluation. Signals are derived views, not a job queue: every pass
 * recomputes from source state, so a crash mid-tick is repaired by the next evaluation.
 * Zero model calls; the only probe is the existing health check.
 */
export class SignalService {
  private readonly now: () => Date;
  private readonly detectors: readonly Detector[];
  private running: Promise<void> | null = null;
  private touchTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SignalServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.detectors = deps.detectors ?? DETECTORS;
  }

  /** Concurrent callers share one in-flight pass. */
  evaluate(): Promise<void> {
    this.running ??= this.runEvaluation().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runEvaluation(): Promise<void> {
    const gathered = await this.deps.inputs();
    await this.deps.store.mutate((ledger) => {
      const now = this.now();
      const at = now.toISOString();
      const inputs: SignalInputs = { ...gathered, now, observations: ledger.observations };
      const next: Record<string, StoredSignal> = {};

      for (const detector of this.detectors) {
        let found: DetectedSignal[] | null;
        try {
          found = detector.detect(inputs);
        } catch (error) {
          log.warn('signal_detector_failed', { kind: detector.kind, ...errorFields(error) });
          found = null;
        }
        if (found === null) {
          for (const item of Object.values(ledger.items)) if (item.kind === detector.kind) next[item.key] = item;
          continue;
        }
        for (const signal of found) next[signal.key] = merge(ledger.items[signal.key], signal, at, now.getTime());
      }

      for (const key of Object.keys(next)) {
        if (!ledger.items[key]) log.info('signal_raised', { key, kind: next[key]!.kind, urgency: next[key]!.urgency });
      }
      for (const item of Object.values(ledger.items)) {
        if (!next[item.key]) log.info('signal_cleared', { key: item.key, kind: item.kind });
      }
      ledger.items = capped(next);
      ledger.evaluatedAt = at;
    });
  }

  /** Re-evaluates first when the ledger is older than five minutes; a failed pass still lists what is known. */
  async list(): Promise<AttentionResponse> {
    const ledger = await this.deps.store.read();
    if (this.isStale(ledger)) {
      try {
        await this.evaluate();
      } catch (error) {
        log.warn('signal_evaluate_failed', errorFields(error));
      }
    }
    return this.view();
  }

  async view(): Promise<AttentionResponse> {
    const [ledger, settings] = await Promise.all([this.deps.store.read(), this.deps.proactivity()]);
    const { items, quiet } = attentionView(Object.values(ledger.items), settings, this.now());
    return { schemaVersion: CONTRACT_VERSION, items, evaluatedAt: ledger.evaluatedAt, quiet, nudges: settings.nudges };
  }

  private isStale(ledger: SignalLedger): boolean {
    return !ledger.evaluatedAt || this.now().getTime() - Date.parse(ledger.evaluatedAt) > STALE_AFTER_MS;
  }

  dismiss(key: string): Promise<SignalActionResult> {
    return this.update(key, (item) => {
      item.state = 'dismissed';
      log.info('signal_dismissed', { key, kind: item.kind });
    });
  }

  snooze(key: string, hours: number): Promise<SignalActionResult> {
    return this.update(key, (item) => {
      item.snoozedUntil = new Date(this.now().getTime() + hours * 3_600_000).toISOString();
      log.info('signal_snoozed', { key, kind: item.kind, hours });
    });
  }

  async markSeen(keys: string[]): Promise<number> {
    return this.deps.store.mutate((ledger) => {
      let changed = 0;
      for (const key of keys) {
        const item = ledger.items[key];
        if (item?.state === 'new') {
          item.state = 'seen';
          changed += 1;
        }
      }
      return changed;
    });
  }

  private update(key: string, fn: (item: StoredSignal) => void): Promise<SignalActionResult> {
    return this.deps.store.mutate((ledger) => {
      const item = ledger.items[key];
      if (!item) return 'not_found' as const;
      fn(item);
      return 'ok' as const;
    });
  }

  /** Records what the student's own sync check saw, so releases surface without a new uni call. */
  async observeSync(status: SyncStatus): Promise<void> {
    if (!status.uniReachable) return;
    const updates = status.courses
      .flatMap((course) => (course.state === 'update' && course.remoteVersion !== undefined ? [{ id: course.id, title: course.title, remoteVersion: course.remoteVersion }] : []));
    await this.deps.store.mutate((ledger) => {
      ledger.observations.sync = { at: this.now().toISOString(), updates };
    });
    this.touch();
  }

  /** Records the first page of the student's own feed read; failed reads keep the last snapshot. */
  async observeFeed(feed: PeerFeedResponse): Promise<void> {
    if (feed.state !== 'ok') return;
    const incoming = feed.items
      .filter((item) => !item.mine && !item.import && !item.ignored)
      .map((item) => ({ id: item.id, revision: item.revision, title: item.payload.title, senderName: item.senderName }));
    await this.deps.store.mutate((ledger) => {
      ledger.observations.feed = { at: this.now().toISOString(), incoming };
    });
    this.touch();
  }

  /** Write triggers call this; bursts of writes collapse into one evaluation. */
  touch(): void {
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      this.evaluate().catch((error) => log.warn('signal_evaluate_failed', errorFields(error)));
    }, TOUCH_DEBOUNCE_MS);
    this.touchTimer.unref();
  }
}
