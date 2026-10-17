import { z } from 'zod';
import { AttentionStateSchema, SignalSchema, TimestampSchema } from '@sef/shared';
import { errorFields, log } from '../config';
import { readJson, writeJson } from '../lib/fs';

export const StoredSignalSchema = SignalSchema.extend({ state: AttentionStateSchema, snoozedUntil: TimestampSchema.optional() });
export type StoredSignal = z.infer<typeof StoredSignalSchema>;

/** Snapshots of uni-backed state the student's own app already fetched; detectors never call the uni. */
const ObservationsSchema = z.strictObject({
  sync: z.strictObject({ at: TimestampSchema, updates: z.array(z.strictObject({ id: z.string(), title: z.string(), remoteVersion: z.string() })) }).optional(),
  feed: z
    .strictObject({
      at: TimestampSchema,
      incoming: z.array(z.strictObject({ id: z.string(), revision: z.string(), title: z.string(), senderName: z.string() })),
    })
    .optional(),
});
export type Observations = z.infer<typeof ObservationsSchema>;

const LedgerSchema = z.strictObject({
  version: z.literal(1),
  evaluatedAt: TimestampSchema.nullable(),
  items: z.record(z.string(), StoredSignalSchema),
  observations: ObservationsSchema,
});
export type SignalLedger = z.infer<typeof LedgerSchema>;

const emptyLedger = (): SignalLedger => ({ version: 1, evaluatedAt: null, items: {}, observations: {} });

/**
 * One student's signal ledger, beside their logistics file and outside the vault: it can
 * quote private deadlines, so it must never ride along in a vault export. Writes are
 * serialised read-modify-write cycles over an atomic file replace.
 */
export class SignalStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<SignalLedger> {
    try {
      const parsed = LedgerSchema.safeParse(await readJson(this.file, emptyLedger()));
      if (parsed.success) return parsed.data;
      log.warn('signal_ledger_invalid', { file: this.file, issues: parsed.error.issues.length });
    } catch (error) {
      log.warn('signal_ledger_unreadable', { file: this.file, ...errorFields(error) });
    }
    // Every signal is derived, so a fresh ledger is rebuilt on the next evaluation.
    return emptyLedger();
  }

  mutate<T>(fn: (ledger: SignalLedger) => T | Promise<T>): Promise<T> {
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
