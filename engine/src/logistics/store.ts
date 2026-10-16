import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  LogisticsRecordSchema,
  compareLogistics,
  type LogisticsProvenance,
  type LogisticsRecord,
  type LogisticsWrite,
} from '@sef/shared';
import { readJson, writeJson } from '../lib/fs';

/**
 * The student's private logistics ledger — one JSON file inside their workspace, so
 * two profiles on one device never see each other's deadlines. Reads are per request;
 * writes are serialised read-modify-write cycles, because a UI edit and a Friend
 * extraction finishing mid-turn can land at the same moment.
 */
const StoreSchema = z.strictObject({ records: z.record(z.string(), LogisticsRecordSchema) });

/** The read side of the store — the slice the Friend's context needs. */
export interface LogisticsReader {
  confirmed(): Promise<LogisticsRecord[]>;
  proposed(): Promise<LogisticsRecord[]>;
}

/** The write surface extraction needs on top of the reader. */
export interface LogisticsAccess extends LogisticsReader {
  propose(drafts: LogisticsWrite[], provenance: LogisticsProvenance): Promise<LogisticsRecord[]>;
}

/** A transition the record's state does not allow — the route answers 409. */
export class LogisticsStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogisticsStateError';
  }
}

const dedupeKey = (r: Pick<LogisticsRecord, 'title' | 'kind' | 'dueAt'>) => `${r.title.trim().toLowerCase()}|${r.kind}|${r.dueAt ?? ''}`;

export class LogisticsStore implements LogisticsAccess {
  constructor(private readonly file: string) {}

  /** Serialises read-modify-write cycles so concurrent mutations cannot lose records. */
  private queue: Promise<unknown> = Promise.resolve();

  private async read(): Promise<Record<string, LogisticsRecord>> {
    const parsed = StoreSchema.safeParse(await readJson(this.file, { records: {} }));
    return parsed.success ? parsed.data.records : {};
  }

  private mutate<T>(fn: (records: Record<string, LogisticsRecord>) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const records = await this.read();
      const out = await fn(records);
      await writeJson(this.file, { records });
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Everything, sorted for display: dated records nearest-first, undated last. */
  async list(): Promise<LogisticsRecord[]> {
    return Object.values(await this.read()).sort(compareLogistics);
  }

  async confirmed(): Promise<LogisticsRecord[]> {
    return (await this.list()).filter((r) => r.state === 'confirmed');
  }

  async proposed(): Promise<LogisticsRecord[]> {
    return (await this.list()).filter((r) => r.state === 'proposed');
  }

  async get(id: string): Promise<LogisticsRecord | null> {
    return (await this.read())[id] ?? null;
  }

  /** A student-typed record is confirmed at birth — it is their own statement, not a proposal. */
  async create(input: LogisticsWrite, provenance: LogisticsProvenance): Promise<LogisticsRecord> {
    return this.mutate((records) => {
      const now = new Date().toISOString();
      const record: LogisticsRecord = { ...input, id: `log-${randomUUID()}`, state: 'confirmed', provenance, createdAt: now, updatedAt: now };
      records[record.id] = record;
      return record;
    });
  }

  /**
   * Extraction drafts land as proposals. A draft that duplicates a record the student
   * already holds — same title, kind and due — is skipped, not filed twice.
   */
  async propose(drafts: LogisticsWrite[], provenance: LogisticsProvenance): Promise<LogisticsRecord[]> {
    return this.mutate((records) => {
      const now = new Date().toISOString();
      const known = new Set(Object.values(records).map(dedupeKey));
      const filed: LogisticsRecord[] = [];
      for (const draft of drafts) {
        const key = dedupeKey(draft);
        if (known.has(key)) continue;
        known.add(key);
        const record: LogisticsRecord = { ...draft, id: `log-${randomUUID()}`, state: 'proposed', provenance, createdAt: now, updatedAt: now };
        records[record.id] = record;
        filed.push(record);
      }
      return filed;
    });
  }

  /** Editable fields only; state and provenance move through their own transitions. */
  async update(id: string, patch: Partial<LogisticsWrite>): Promise<LogisticsRecord> {
    return this.mutate((records) => {
      const record = records[id];
      if (!record) throw new LogisticsNotFound(id);
      if (record.state === 'dismissed') throw new LogisticsStateError('A dismissed record cannot be edited — delete it or file a new one.');
      records[id] = { ...record, ...patch, updatedAt: new Date().toISOString() };
      return records[id]!;
    });
  }

  /** The student's confirmation is the only thing that turns a proposal into fact. */
  async confirm(id: string, patch: Partial<LogisticsWrite> = {}): Promise<LogisticsRecord> {
    return this.mutate((records) => {
      const record = records[id];
      if (!record) throw new LogisticsNotFound(id);
      if (record.state !== 'proposed') throw new LogisticsStateError('Only a proposed record can be confirmed.');
      records[id] = { ...record, ...patch, state: 'confirmed', updatedAt: new Date().toISOString() };
      return records[id]!;
    });
  }

  /** A rejected proposal is kept on record rather than deleted — the audit stays honest. */
  async dismiss(id: string): Promise<LogisticsRecord> {
    return this.mutate((records) => {
      const record = records[id];
      if (!record) throw new LogisticsNotFound(id);
      if (record.state !== 'proposed') throw new LogisticsStateError('Only a proposed record can be dismissed.');
      records[id] = { ...record, state: 'dismissed', updatedAt: new Date().toISOString() };
      return records[id]!;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((records) => {
      if (!records[id]) return false;
      delete records[id];
      return true;
    });
  }
}

export class LogisticsNotFound extends Error {
  constructor(id: string) {
    super(`No logistics record ${id}`);
    this.name = 'LogisticsNotFound';
  }
}
