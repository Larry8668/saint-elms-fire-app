import { CLIENT_METRIC_KINDS, MAX_CLIENT_EVENTS_PER_CALL } from '@sef/shared';

export type ClientMetricKind = (typeof CLIENT_METRIC_KINDS)[number];
export interface ClientMetricEvent {
  kind: ClientMetricKind;
  ref: string;
  tag?: string;
}

export interface MetricsReporter {
  report(kind: ClientMetricKind, ref: string, tag?: string): void;
  flush(): Promise<void>;
  /** Drops queued events and the shown-once memory — on profile switch, so nothing crosses students. */
  reset(): void;
}

interface ReporterOptions {
  send: (events: ClientMetricEvent[]) => Promise<unknown>;
  onError?: (error: unknown, dropped: number) => void;
  flushMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

const SHOWN = new Set<ClientMetricKind>(['nudge_shown', 'suggestion_shown']);
const TAG = /^[a-z_]{1,40}$/;

/**
 * Batches what only the UI can see. "Shown" is reported once per item per session — the
 * engine counts distinct items anyway, this just keeps refetches from flooding the log.
 * A failed send is dropped, not retried: counters are best-effort and never block the UI.
 */
export function createMetricsReporter({ send, onError, flushMs = 3_000, schedule = setTimeout, cancel = (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }: ReporterOptions): MetricsReporter {
  let queue: ClientMetricEvent[] = [];
  let shown = new Set<string>();
  let timer: unknown = null;
  let generation = 0;

  const flush = async () => {
    if (timer !== null) cancel(timer);
    timer = null;
    const mine = generation;
    while (queue.length && mine === generation) {
      const batch = queue.splice(0, MAX_CLIENT_EVENTS_PER_CALL);
      try {
        await send(batch);
      } catch (error) {
        onError?.(error, batch.length);
      }
    }
  };

  return {
    report(kind, ref, tag) {
      if (!ref) return;
      if (SHOWN.has(kind)) {
        const id = `${kind}|${ref}`;
        if (shown.has(id)) return;
        shown.add(id);
      }
      // The engine rejects a whole batch on one bad tag; drop the tag rather than the batch.
      queue.push({ kind, ref: ref.slice(0, 200), ...(tag && TAG.test(tag) ? { tag } : {}) });
      timer ??= schedule(() => void flush(), flushMs);
    },
    flush,
    reset() {
      generation += 1;
      queue = [];
      shown = new Set();
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}
