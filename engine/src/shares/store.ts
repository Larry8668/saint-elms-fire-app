import { PublishedShareSchema, type PublishedShare } from '@sef/shared';
import { z } from 'zod';
import { readJson, writeJson } from '../lib/fs';

/**
 * The student's local share ledger — inside their own workspace, so two students on
 * one device never see each other's publications.
 *
 * `published` records every share this device sent, so the author can still see items
 * that later became withdrawn (the cohort feed only ever lists `published` ones).
 * `ignored` hides feed items locally; it is not a signal the uni knows about.
 */
const StoredShareSchema = PublishedShareSchema.omit({ schemaVersion: true });
export type StoredShare = z.infer<typeof StoredShareSchema>;

const PeerShareStateSchema = z.strictObject({
  published: z.record(z.string(), StoredShareSchema),
  ignored: z.array(z.string()),
});
export type PeerShareState = z.infer<typeof PeerShareStateSchema>;

const EMPTY: PeerShareState = { published: {}, ignored: [] };

export class PeerShareStore {
  constructor(private readonly file: string) {}

  async read(): Promise<PeerShareState> {
    const parsed = PeerShareStateSchema.safeParse(await readJson(this.file, EMPTY));
    return parsed.success ? parsed.data : EMPTY;
  }

  /** Recorded at publish time and refreshed whenever the uni confirms a newer state. */
  async recordPublished(share: PublishedShare): Promise<void> {
    const state = await this.read();
    const { schemaVersion: _v, ...stored } = share;
    state.published[share.id] = stored;
    await writeJson(this.file, state);
  }

  async updateState(id: string, state: 'published' | 'withdrawn', revision: string): Promise<void> {
    const stored = await this.read();
    const entry = stored.published[id];
    if (!entry) return;
    stored.published[id] = { ...entry, state, revision };
    await writeJson(this.file, stored);
  }

  async setIgnored(id: string, ignored: boolean): Promise<void> {
    const state = await this.read();
    const set = new Set(state.ignored);
    if (ignored) set.add(id);
    else set.delete(id);
    state.ignored = [...set];
    await writeJson(this.file, state);
  }
}
