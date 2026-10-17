import { z } from 'zod';
import { assertVaultRelPath } from '../store/keys';
import type { SyncKind } from './scope';

export const SYNC_MANIFEST_FORMAT = 1 as const;
/** Tombstones outlive any realistic gap between two sessions, then age out. */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 20_000;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const RelPath = z.string().refine((value) => {
  try {
    assertVaultRelPath(value);
    return true;
  } catch {
    return false;
  }
}, 'not a safe vault path');

export const SyncFileSchema = z.strictObject({
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  mtime: z.number().nonnegative(),
  /** Where the bytes live: files/<path> ('text') or blobs/sha256/… ('media', 'large'). */
  kind: z.enum(['text', 'media', 'large']),
});
export type SyncFile = z.infer<typeof SyncFileSchema>;

export const SyncTombstoneSchema = z.strictObject({ deletedAt: z.string().min(1), sha256: Sha256 });
export type SyncTombstone = z.infer<typeof SyncTombstoneSchema>;

/**
 * `vaults/<account>/manifest.json`: the one object that says which bytes make up the vault's
 * latest version. Every write is a compare-and-swap on its ETag, so `version` only ever moves
 * forward by one writer at a time.
 */
export const SyncManifestSchema = z.strictObject({
  format: z.literal(SYNC_MANIFEST_FORMAT),
  account: z.string().min(1),
  version: z.number().int().nonnegative(),
  updatedAt: z.string(),
  files: z.record(RelPath, SyncFileSchema),
  tombstones: z.record(RelPath, SyncTombstoneSchema),
});
export type SyncManifest = z.infer<typeof SyncManifestSchema>;

export function emptySyncManifest(account: string): SyncManifest {
  return { format: SYNC_MANIFEST_FORMAT, account, version: 0, updatedAt: new Date(0).toISOString(), files: {}, tombstones: {} };
}

export interface LocalEntry {
  sha256: string;
  size: number;
  mtime: number;
  kind: SyncKind;
}

export interface ManifestDiff {
  /** New or changed since the base manifest. */
  upload: string[];
  /** In the base but gone locally. */
  deleted: string[];
}

/** What a push must send. */
export function diffManifest(base: SyncManifest, local: ReadonlyMap<string, LocalEntry>): ManifestDiff {
  const upload: string[] = [];
  const deleted: string[] = [];
  for (const [relPath, entry] of local) {
    const known = base.files[relPath];
    if (!known || known.sha256 !== entry.sha256 || known.kind !== entry.kind) upload.push(relPath);
  }
  for (const relPath of Object.keys(base.files)) {
    if (!local.has(relPath)) deleted.push(relPath);
  }
  return { upload: upload.sort(), deleted: deleted.sort() };
}

/** The next manifest version: the local files, and tombstones for deletes. */
export function nextManifest(base: SyncManifest, local: ReadonlyMap<string, LocalEntry>, diff: ManifestDiff, at: Date): SyncManifest {
  const files: Record<string, SyncFile> = {};
  for (const [relPath, entry] of local) files[relPath] = { sha256: entry.sha256, size: entry.size, mtime: entry.mtime, kind: entry.kind };
  const tombstones: Record<string, SyncTombstone> = {};
  for (const [relPath, tombstone] of Object.entries(base.tombstones)) {
    // A path written again is alive; an old enough tombstone has done its job everywhere.
    if (!files[relPath] && at.getTime() - Date.parse(tombstone.deletedAt) < TOMBSTONE_TTL_MS) tombstones[relPath] = tombstone;
  }
  for (const relPath of diff.deleted) tombstones[relPath] = { deletedAt: at.toISOString(), sha256: base.files[relPath]!.sha256 };
  const kept = Object.entries(tombstones).sort(([, a], [, b]) => b.deletedAt.localeCompare(a.deletedAt)).slice(0, MAX_TOMBSTONES);
  return { ...base, version: base.version + 1, updatedAt: at.toISOString(), files, tombstones: Object.fromEntries(kept) };
}

/** Blob hashes a manifest still needs; anything else under blobs/ may be deleted after a swap. */
export function referencedBlobs(manifest: SyncManifest): Set<string> {
  const hashes = new Set<string>();
  for (const file of Object.values(manifest.files)) if (file.kind !== 'text') hashes.add(file.sha256);
  return hashes;
}
