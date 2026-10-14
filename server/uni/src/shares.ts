import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config';

export const NewShareSchema = z.object({
  cohortId: z.string().min(1),
  fromStudent: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  markdown: z.string().max(config.shareMaxBytes),
  image: z.object({ mimeType: z.string(), data: z.string() }).optional(),
});
export type NewShare = z.infer<typeof NewShareSchema>;

export interface Share extends NewShare {
  id: string;
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
    try {
      this.shares = JSON.parse(await readFile(this.file, 'utf8')) as Share[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.shares = [];
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.shares, null, 2));
  }

  async add(input: NewShare): Promise<Share> {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.shares.filter((s) => s.fromStudent === input.fromStudent && Date.parse(s.createdAt) > dayAgo);
    if (recent.length >= config.sharesPerDay) throw new ShareLimitError(`Limit of ${config.sharesPerDay} shares per day reached`);
    const share: Share = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.shares.push(share);
    await this.persist();
    return share;
  }

  list(cohortId: string, since?: string): Share[] {
    const after = since ? Date.parse(since) : 0;
    return this.shares.filter((s) => s.cohortId === cohortId && Date.parse(s.createdAt) > after);
  }
}
