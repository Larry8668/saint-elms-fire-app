import type { MetricEventKind, MetricsReport, RecordMetricsRequest } from '@sef/shared';
import { errorFields, log } from '../config';
import type { MetricsLog } from './log';
import { aggregate, type ReportExtras } from './report';

/** How engine-side services report an event; fire-and-forget, never fails the caller. */
export type RecordMetric = (kind: MetricEventKind, ref: string, tag?: string) => void;

export interface MetricsServiceDeps {
  log: MetricsLog;
  turns: () => Promise<ReportExtras['turns']>;
  proposals: () => Promise<ReportExtras['proposals']>;
  now?: () => Date;
}

const EMPTY_EXTRAS: ReportExtras = { turns: { total: 0, refused: 0 }, proposals: { accepted: 0, rejected: 0 } };

/** Local counters for one profile. Nothing here leaves the device. */
export class MetricsService {
  constructor(private readonly deps: MetricsServiceDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** Engine-side hook: a broken counter file must never break a dismiss or an approval. */
  readonly record: RecordMetric = (kind, ref, tag) => {
    void this.deps.log.append([{ kind, ref: ref.slice(0, 200), at: this.now().toISOString(), ...(tag ? { tag } : {}) }]).catch((error) => {
      log.warn('metric_record_failed', { kind, ...errorFields(error) });
    });
  };

  /** UI-reported events; the engine stamps the time so a client cannot backdate one. */
  async recordClient(request: RecordMetricsRequest): Promise<number> {
    const at = this.now().toISOString();
    await this.deps.log.append(request.events.map((e) => ({ ...e, at })));
    return request.events.length;
  }

  async report(): Promise<MetricsReport> {
    const [events, turns, proposals] = await Promise.all([
      this.deps.log.read(),
      this.deps.turns().catch((error) => {
        log.warn('metric_source_failed', { source: 'turns', ...errorFields(error) });
        return EMPTY_EXTRAS.turns;
      }),
      this.deps.proposals().catch((error) => {
        log.warn('metric_source_failed', { source: 'proposals', ...errorFields(error) });
        return EMPTY_EXTRAS.proposals;
      }),
    ]);
    return aggregate(events, { turns, proposals }, this.now());
  }
}
