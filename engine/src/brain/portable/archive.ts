import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { VAULT_EXPORT_VERSION, VaultExportSchema, type VaultExport, type VaultExportFile } from '@sef/shared';
import { sha256Hex } from '../../lib/hash';
import {
  HISTORY_DIRECTORY,
  KIND_DIRECTORY,
  LOG_FILE,
  META_DIRECTORY,
  META_EVENTS_DIRECTORY,
  META_SOURCES_DIRECTORY,
  META_TOMBSTONES_DIRECTORY,
  RAW_DIRECTORY,
  VAULT_LAYOUT_VERSION,
  assertRelativeVaultPath,
  pageIdFromFileName,
  type PageKind,
} from '../vault-layout';
import { INGEST_LIMITS } from '../sources/limits';

/**
 * The archive format's pure half: what a file path is allowed to mean, and the checks that
 * run before any of it is trusted. No filesystem here — the service reads the vault itself.
 */

/** An import that cannot run, said plainly. `code` and `status` travel to the route unchanged. */
export class VaultImportError extends Error {
  constructor(
    message: string,
    readonly code: 'malformed' | 'newer_schema' | 'unsafe' | 'integrity' | 'too_large',
    readonly status: ContentfulStatusCode,
  ) {
    super(message);
    this.name = 'VaultImportError';
  }
}

/** Archive caps, independent of the ingest limits they borrow. Injectable so tests can squeeze them. */
export const PORTABLE_LIMITS = {
  /** One file may not exceed the per-source ceiling the vault already enforces. */
  maxFileBytes: INGEST_LIMITS.maxSourceBytes,
  /** A student's whole vault stays a laptop-sized object, and the base64 envelope it travels in must still fit the request cap. */
  maxTotalBytes: 96 * 1024 * 1024,
  maxFiles: 20_000,
} as const;

export interface PortableLimits {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

/** A single path segment that can never carry a traversal, a separator or a hidden file. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** The only dot-prefixed roots the vault owns — everything else hidden is refused. */
const DOTTED_ROOTS = new Set([META_DIRECTORY, HISTORY_DIRECTORY]);
const segmentsSafe = (segments: string[]): boolean => segments.every((segment, index) => SAFE_SEGMENT.test(segment) || (index === 0 && DOTTED_ROOTS.has(segment)));

export type ArchiveFile =
  | { area: 'page'; kind: PageKind; id: string }
  | { area: 'history' }
  | { area: 'source_record'; id: string }
  | { area: 'source_extracted'; id: string }
  | { area: 'raw'; id: string }
  | { area: 'event'; id: string }
  | { area: 'tombstone'; id: string }
  | { area: 'log' };

const KIND_DIRS = new Map<string, PageKind>(Object.entries(KIND_DIRECTORY).map(([kind, dir]) => [dir, kind as PageKind]));

const jsonId = (stem: string): string | null => (stem.endsWith('.json') && SAFE_ID.test(stem.slice(0, -5)) ? stem.slice(0, -5) : null);

/**
 * Where an archived path would land in the vault, or null when it is not a path the export
 * format owns. Derived state (index.md, SCHEMA.md, .meta/manifest.json), in-flight state
 * (journal, jobs, proposals, recovery, the writer lock) and anything outside the student-owned
 * areas are all refused — an import only ever writes what a vault legitimately holds.
 */
export function classifyArchivePath(relativePath: string): ArchiveFile | null {
  let safe: string;
  try {
    safe = assertRelativeVaultPath(relativePath);
  } catch {
    return null;
  }
  if (safe === LOG_FILE) return { area: 'log' };
  const segments = safe.split('/');
  if (!segmentsSafe(segments)) return null;
  const [first, second] = segments;

  if (segments.length === 2 && KIND_DIRS.has(first!)) {
    const id = pageIdFromFileName(second!);
    return id ? { area: 'page', kind: KIND_DIRS.get(first!)!, id } : null;
  }
  if (first === HISTORY_DIRECTORY && segments.length >= 3 && segments.at(-1)!.endsWith('.md')) return { area: 'history' };
  if (first === RAW_DIRECTORY && segments.length === 3 && SAFE_ID.test(second!)) return { area: 'raw', id: second! };
  if (first === META_DIRECTORY && segments.length === 3) {
    const id = jsonId(segments[2]!);
    if (!id) return null;
    if (second === META_SOURCES_DIRECTORY) return { area: 'source_record', id };
    if (second === META_EVENTS_DIRECTORY) return { area: 'event', id };
    if (second === META_TOMBSTONES_DIRECTORY) return { area: 'tombstone', id };
    return null;
  }
  if (first === META_DIRECTORY && second === META_SOURCES_DIRECTORY && segments.length === 5 && segments[3] === 'extracted' && segments[4]!.endsWith('.txt') && SAFE_ID.test(segments[2]!)) {
    return { area: 'source_extracted', id: segments[2]! };
  }
  return null;
}

/** The decoded bytes of one archived file — utf8 straight through, base64 for originals. */
export function decodeExportFile(file: VaultExportFile): Buffer {
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
}

/**
 * Everything that must be true before an archive may even be previewed. A failure is a
 * refusal, never a partial plan: malformed structure, a newer writer, an unsafe path, a
 * hash that does not match, or simply too much.
 */
export function parseArchive(raw: unknown, limits: PortableLimits = {}): VaultExport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultImportError('That file is not a vault export.', 'malformed', 400);
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === 'number' && version > VAULT_EXPORT_VERSION) {
    throw new VaultImportError('This export was written by a newer version of the app and cannot be restored here.', 'newer_schema', 409);
  }
  const parsed = VaultExportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new VaultImportError(`That file is not a vault export${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}.`, 'malformed', 400);
  }
  const archive = parsed.data;
  if (archive.layout > VAULT_LAYOUT_VERSION) {
    throw new VaultImportError('This export comes from a newer vault layout and cannot be restored here.', 'newer_schema', 409);
  }

  const maxFiles = limits.maxFiles ?? PORTABLE_LIMITS.maxFiles;
  const maxFileBytes = limits.maxFileBytes ?? PORTABLE_LIMITS.maxFileBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? PORTABLE_LIMITS.maxTotalBytes;
  if (archive.files.length > maxFiles) {
    throw new VaultImportError(`This export holds ${archive.files.length} files; the limit is ${maxFiles}.`, 'too_large', 413);
  }
  let total = 0;
  const seen = new Set<string>();
  for (const file of archive.files) {
    if (seen.has(file.path)) {
      throw new VaultImportError(`This export lists ${file.path} twice.`, 'malformed', 400);
    }
    seen.add(file.path);
    if (file.bytes > maxFileBytes) {
      throw new VaultImportError(`${file.path} is larger than the per-file limit.`, 'too_large', 413);
    }
    total += file.bytes;
    if (total > maxTotalBytes) {
      throw new VaultImportError('This export is larger than the vault import limit.', 'too_large', 413);
    }
    if (classifyArchivePath(file.path) === null) {
      throw new VaultImportError(`This export contains ${file.path}, which is not a vault-owned path.`, 'unsafe', 400);
    }
    // The per-file hash is the archive's own manifest: nothing is trusted until it matches.
    const bytes = decodeExportFile(file);
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) {
      throw new VaultImportError(`This export fails its own checksum at ${file.path}.`, 'integrity', 422);
    }
  }
  return archive;
}
