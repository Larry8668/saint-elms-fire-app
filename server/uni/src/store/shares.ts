import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { readJson, writeJson } from './json-file';

/** What a student device sends. Cohort and author come from the verified token, never the body. */
export const ShareBodySchema = z.object({
  title: z.string().min(1).max(160),
  markdown: z.string().max(config.shareMaxBytes),
  image: z.object({ mimeType: z.string(), data: z.string() }).optional(),
});
export type ShareBody = z.infer<typeof ShareBodySchema>;

export interface Share extends ShareBody {
  id: string;
  cohortId: string;
  fromStudent: string;
  fromAccountId?: string;
  createdAt: string;
}

export class ShareLimitError extends Error {}

/** File-backed relay: shares are cohort-scoped and read by peers; acceptance happens on devices. */
export class ShareStore {
  private shares: Share[] = [];
  private readonly file: string;

  constructor(dataDir = config.dataDir) {
    this.file = path.join(dataDir, 'shares.json');
  }

  async load(): Promise<void> {
    this.shares = await readJson<Share[]>(this.file, []);
  }

  private persist(): Promise<void> {
    return writeJson(this.file, this.shares);
  }

  async add(input: Omit<Share, 'id' | 'createdAt'> & { createdAt?: string }): Promise<Share> {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.shares.filter((s) => s.fromAccountId === input.fromAccountId && Date.parse(s.createdAt) > dayAgo);
    if (!input.createdAt && recent.length >= config.sharesPerDay) {
      throw new ShareLimitError(`Limit of ${config.sharesPerDay} shares per day reached`);
    }
    const share: Share = { ...input, id: randomUUID(), createdAt: input.createdAt ?? new Date().toISOString() };
    this.shares.push(share);
    await this.persist();
    return share;
  }

  list(cohortId: string, since?: string): Share[] {
    const after = since ? Date.parse(since) : 0;
    return this.shares.filter((s) => s.cohortId === cohortId && Date.parse(s.createdAt) > after);
  }

  all(): Share[] {
    return [...this.shares].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<Share | undefined> {
    const share = this.shares.find((s) => s.id === id);
    if (!share) return undefined;
    this.shares = this.shares.filter((s) => s.id !== id);
    await this.persist();
    return share;
  }
}
