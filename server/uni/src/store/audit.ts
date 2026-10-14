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
    this.entries.push(entry);
    if (this.entries.length > MEMORY_LIMIT) this.entries.shift();
    log.info('audit', { ...entry });
    await appendJsonLine(this.file, entry);
  }

  recent(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
