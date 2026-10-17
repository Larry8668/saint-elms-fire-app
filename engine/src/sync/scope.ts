import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertVaultRelPath } from '../store/keys';

/**
 * What vault sync carries, as profile-relative POSIX paths (the profile root is
 * ENGINE_DATA_DIR/profiles/<id>/). An allowlist: a store added tomorrow is not synced until
 * it is named here on purpose. The table in docs/object-store.md mirrors this file.
 *
 *  - text:  a file object under files/<path>, fetched on restore.
 *  - media: brain/raw/ originals, content-addressed under blobs/sha256/…, uploaded once.
 *  - large: any other file of 1 MiB or more, content-addressed the same way.
 * Both blob kinds are fetched during the restore (lazy media is PR-41c).
 */
export type SyncKind = 'text' | 'media' | 'large';

/** Top-level directories and files a student needs to resume, exactly as the engine lays them out. */
const SYNCED_DIRECTORIES = new Set(['brain', 'sessions', 'quizzes', 'content', 'plans']);
const SYNCED_FILES = new Set(['logistics.json', 'feeds.json', 'signals.json', 'shares.json']);

/**
 * Never synced, even inside a synced directory:
 *  - brain/.meta/writer.lock and journal/: in-flight state of this one process. An interrupted
 *    commit is finished locally by recover(); its result then syncs like any other write.
 *  - brain/.meta/embeddings/: derived vectors, rebuilt by the existing code (an optional cache is PR-41c).
 *  - *.tmp: a writeFileAtomic temp file caught mid-rename.
 * Outside the allowlist (so never synced): private-settings.json (provider credentials),
 * eval-events.jsonl (local-only counters, promised never sent), suggestions-*.json (a cache),
 * the sync's own state, and every device-level file (auth sessions, trust, profiles, settings).
 */
const EXCLUDED_PREFIXES = ['brain/.meta/writer.lock', 'brain/.meta/journal/', 'brain/.meta/embeddings/'];
export const MEDIA_DIRECTORY = 'brain/raw/';
/** Anything this big outside raw/ is stored content-addressed too, so it is uploaded once. */
export const LARGE_FILE_BYTES = 1024 * 1024;

export function syncKind(relPath: string, size: number): SyncKind | null {
  const top = relPath.split('/')[0]!;
  const inScope = relPath.includes('/') ? SYNCED_DIRECTORIES.has(top) : SYNCED_FILES.has(relPath);
  if (!inScope || relPath.endsWith('.tmp')) return null;
  if (EXCLUDED_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(prefix))) return null;
  try {
    assertVaultRelPath(relPath);
  } catch {
    return null;
  }
  if (relPath.startsWith(MEDIA_DIRECTORY)) return 'media';
  return size >= LARGE_FILE_BYTES ? 'large' : 'text';
}

export interface LocalFile {
  relPath: string;
  kind: SyncKind;
  size: number;
  mtimeMs: number;
}

/**
 * Every synced regular file under the profile root. Symlinks are skipped, never followed, so a
 * link planted in the vault cannot pull a file from elsewhere on the box into the bucket.
 */
export async function scanProfile(root: string): Promise<Map<string, LocalFile>> {
  const files = new Map<string, LocalFile>();
  const walk = async (relDir: string): Promise<void> => {
    const entries = await readdir(path.join(root, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relDir === '' && !SYNCED_DIRECTORIES.has(entry.name)) continue;
        if (EXCLUDED_PREFIXES.some((prefix) => `${relPath}/`.startsWith(prefix))) continue;
        await walk(relPath);
      } else if (entry.isFile()) {
        const info = await lstat(path.join(root, relPath)).catch(() => null);
        if (!info?.isFile()) continue;
        const kind = syncKind(relPath, info.size);
        if (kind) files.set(relPath, { relPath, kind, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };
  await walk('');
  return files;
}
