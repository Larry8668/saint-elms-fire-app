import path from 'node:path';
import { readJson, writeJson } from '../lib/fs';

export interface EmbeddingIndexFile {
  /** The embed model that produced these vectors — a different model means a rebuild. */
  model: string;
  provider: string;
  entries: Record<string, number[]>;
}

/**
 * One JSON file per scope under the vault's `.meta/embeddings/`. This is a derived cache
 * of an embedding model's output — a missing or corrupt file simply costs a rebuild.
 * The path is never inside an export area, so vectors never leave this device.
 */
export class EmbeddingIndex {
  constructor(private readonly dir: string) {}

  private file(scope: string): string {
    return path.join(this.dir, `${scope}.json`);
  }

  async read(scope: string): Promise<EmbeddingIndexFile | null> {
    const stored = await readJson<EmbeddingIndexFile | null>(this.file(scope), null).catch(() => null);
    if (!stored || typeof stored.model !== 'string' || typeof stored.entries !== 'object' || stored.entries === null) return null;
    return stored;
  }

  async write(scope: string, file: EmbeddingIndexFile): Promise<void> {
    await writeJson(this.file(scope), file);
  }
}
