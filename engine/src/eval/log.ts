import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MetricEventSchema, type MetricEvent } from '@sef/shared';
import { log } from '../config';
import { writeFileAtomic } from '../lib/fs';

export const MAX_EVENTS = 10_000;
/** Rotation keeps the newest half, so it runs rarely rather than on every append past the cap. */
export const KEEP_ON_ROTATE = 5_000;

/**
 * Append-only JSONL of metric events for one profile. Appends are serialised; past the cap
 * the file is atomically rewritten with the newest events. Lines that fail the contract are
 * skipped on read — a counter file is never a reason to fail a request.
 */
export class MetricsLog {
  private queue: Promise<unknown> = Promise.resolve();
  private lines: number | null = null;

  constructor(
    private readonly file: string,
    private readonly limits = { max: MAX_EVENTS, keep: KEEP_ON_ROTATE },
  ) {}

  append(events: MetricEvent[]): Promise<void> {
    if (!events.length) return Promise.resolve();
    const run = this.queue.then(async () => {
      const valid = events.filter((e) => MetricEventSchema.safeParse(e).success);
      if (!valid.length) return;
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, valid.map((e) => `${JSON.stringify(e)}\n`).join(''));
      this.lines = this.lines === null ? (await this.readRaw()).length : this.lines + valid.length;
      if (this.lines > this.limits.max) await this.rotate();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async read(): Promise<MetricEvent[]> {
    await this.queue;
    return this.parse(await this.readRaw());
  }

  private async readRaw(): Promise<string[]> {
    const text = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return text.split('\n').filter((line) => line.trim());
  }

  private parse(lines: string[]): MetricEvent[] {
    return lines.flatMap((line) => {
      try {
        const parsed = MetricEventSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  private async rotate(): Promise<void> {
    const kept = (await this.readRaw()).slice(-this.limits.keep);
    await writeFileAtomic(this.file, kept.map((line) => `${line}\n`).join(''));
    log.info('metrics_rotated', { kept: kept.length, dropped: (this.lines ?? 0) - kept.length });
    this.lines = kept.length;
  }
}
