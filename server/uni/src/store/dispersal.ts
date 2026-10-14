import path from 'node:path';
import type { DispersalRecord } from '@sef/shared';
import { config } from '../config';
import { readJson, writeJson } from './json-file';

/** Latest course package each student device pulled. Lets admins see who is on stale content. */
export class DispersalStore {
  private records = new Map<string, DispersalRecord>();
  private readonly file: string;

  constructor(dataDir = config.dataDir) {
    this.file = path.join(dataDir, 'dispersal.json');
  }

  async load(): Promise<void> {
    const rows = await readJson<DispersalRecord[]>(this.file, []);
    this.records = new Map(rows.map((r) => [`${r.accountId}:${r.courseId}`, r]));
  }

  async record(entry: Omit<DispersalRecord, 'at'>): Promise<void> {
    this.records.set(`${entry.accountId}:${entry.courseId}`, { ...entry, at: new Date().toISOString() });
    await writeJson(this.file, [...this.records.values()]);
  }

  /** Seeds history without bumping timestamps (used for demo data). */
  async seed(rows: DispersalRecord[]): Promise<void> {
    for (const r of rows) this.records.set(`${r.accountId}:${r.courseId}`, r);
    await writeJson(this.file, [...this.records.values()]);
  }

  all(): DispersalRecord[] {
    return [...this.records.values()].sort((a, b) => b.at.localeCompare(a.at));
  }
}
