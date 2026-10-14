import path from 'node:path';
import type { AuditEntry } from '@sef/shared';
import { config } from '../config';
import { log } from '../logger';
import { appendJsonLine, readJsonLines } from './json-file';

const MEMORY_LIMIT = 500;

/** Append-only record of who changed what. Kept in memory for the admin panel, persisted as JSONL. */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly file: string;

  constructor(dataDir = config.dataDir) {
    this.file = path.join(dataDir, 'audit.jsonl');
  }

  async load(): Promise<void> {
    this.entries = (await readJsonLines<AuditEntry>(this.file)).slice(-MEMORY_LIMIT);
  }

  async record(actor: string, action: string, detail: string): Promise<void> {
    const entry: AuditEntry = { at: new Date().toISOString(), actor, action, detail };
    await appendJsonLine(this.file, entry);
    this.entries.push(entry);
    if (this.entries.length > MEMORY_LIMIT) this.entries.shift();
    log.info('audit', { ...entry });
  }

  /** Newest first. `limit` is clamped to 1–MEMORY_LIMIT; non-numeric input falls back to 50. */
  recent(limit = 50): AuditEntry[] {
    const n = Number.isFinite(limit) ? Math.min(MEMORY_LIMIT, Math.max(1, Math.floor(limit))) : 50;
    return this.entries.slice(-n).reverse();
  }
}
