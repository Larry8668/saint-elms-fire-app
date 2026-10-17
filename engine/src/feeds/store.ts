import { z } from 'zod';
import { FeedItemSchema, FeedSchema } from '@sef/shared';
import { errorFields, log } from '../config';
import { readJson, writeJson } from '../lib/fs';

const LedgerSchema = z.strictObject({
  version: z.literal(1),
  feeds: z.record(z.string(), FeedSchema),
  items: z.record(z.string(), z.array(FeedItemSchema)),
});
export type FeedLedger = z.infer<typeof LedgerSchema>;

const empty = (): FeedLedger => ({ version: 1, feeds: {}, items: {} });

/**
 * Per-profile `feeds.json`, outside the vault: feed choices and headlines are operational
 * state, not student knowledge. Writes are serialised read-modify-write over an atomic replace.
 */
export class FeedStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<FeedLedger> {
    try {
      const parsed = LedgerSchema.safeParse(await readJson(this.file, empty()));
      if (parsed.success) return parsed.data;
      log.warn('feed_ledger_invalid', { issues: parsed.error.issues.length });
    } catch (error) {
      log.warn('feed_ledger_unreadable', errorFields(error));
    }
    return empty();
  }

  mutate<T>(fn: (ledger: FeedLedger) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const ledger = await this.read();
      const out = await fn(ledger);
      await writeJson(this.file, ledger);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
