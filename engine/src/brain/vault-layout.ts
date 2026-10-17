import path from 'node:path';
import { z } from 'zod';
import { VaultPathError } from './vault-errors';

/** Bumped only when an on-disk shape changes in a way older readers cannot ignore. */
export const VAULT_LAYOUT_VERSION = 2 as const;

export const PAGE_KINDS = ['concept', 'source_summary', 'synthesis', 'question'] as const;
export const PageKindSchema = z.enum(PAGE_KINDS);
export type PageKind = (typeof PAGE_KINDS)[number];

/** The agreed vault layout: sources feed pages, pages are grouped by what they are for. */
export const KIND_DIRECTORY: Record<PageKind, string> = {
  concept: 'concepts',
  source_summary: 'sources',
  synthesis: 'syntheses',
  question: 'questions',
};

export const RAW_DIRECTORY = 'raw';
export const HISTORY_DIRECTORY = '.history';
export const META_DIRECTORY = '.meta';
export const META_MANIFEST_FILE = 'manifest.json';
export const META_SOURCES_DIRECTORY = 'sources';
export const META_JOBS_DIRECTORY = 'jobs';
export const META_PROPOSALS_DIRECTORY = 'proposals';
export const META_EVENTS_DIRECTORY = 'events';
export const META_JOURNAL_DIRECTORY = 'journal';
export const META_RECOVERY_DIRECTORY = 'recovery';
/** Erasure markers: a deleted source leaves one small record so a future sync can carry the delete. */
export const META_TOMBSTONES_DIRECTORY = 'tombstones';
/** Derived vector indexes live here; rebuildable at any time and never part of an export. */
export const META_EMBEDDINGS_DIRECTORY = 'embeddings';
export const META_MAINTENANCE_FILE = 'maintenance.json';
export const INDEX_FILE = 'index.md';
export const LOG_FILE = 'log.md';
export const SCHEMA_FILE = 'SCHEMA.md';
export const WRITER_LOCK_FILE = 'writer.lock';

export const VAULT_DIRECTORIES = [
  ...Object.values(KIND_DIRECTORY),
  RAW_DIRECTORY,
  HISTORY_DIRECTORY,
  META_DIRECTORY,
  `${META_DIRECTORY}/${META_SOURCES_DIRECTORY}`,
  `${META_DIRECTORY}/${META_JOBS_DIRECTORY}`,
  `${META_DIRECTORY}/${META_PROPOSALS_DIRECTORY}`,
  `${META_DIRECTORY}/${META_EVENTS_DIRECTORY}`,
  `${META_DIRECTORY}/${META_JOURNAL_DIRECTORY}`,
  `${META_DIRECTORY}/${META_RECOVERY_DIRECTORY}`,
  `${META_DIRECTORY}/${META_TOMBSTONES_DIRECTORY}`,
  `${META_DIRECTORY}/${META_EMBEDDINGS_DIRECTORY}`,
] as const;

const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SAFE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Page, source and job ids become file names, so they must not contain a separator or a leading dot. */
export function assertRecordId(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !RECORD_ID_PATTERN.test(value)) {
    throw new VaultPathError(`${label} is not a vault-safe identifier`);
  }
  return value;
}

/** Revisions are contract strings; only this narrower set may be used inside a path. */
export function assertSafeRevision(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || !SAFE_REVISION_PATTERN.test(value)) {
    throw new VaultPathError(`${label} cannot be used in a vault path`);
  }
  return value;
}

export function vaultPath(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new VaultPathError('Refusing a path outside the vault root');
  }
  return target;
}

/** Journal steps carry vault-relative paths; they must not climb out or point at an absolute location. */
export function assertRelativeVaultPath(relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new VaultPathError('Vault paths must be relative');
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new VaultPathError('Vault paths must not contain empty, current or parent segments');
  }
  return segments.join('/');
}

export function pageIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith('.md')) return null;
  const id = fileName.slice(0, -3);
  return RECORD_ID_PATTERN.test(id) ? id : null;
}

export function pageRelativePath(kind: PageKind, id: string): string {
  return `${KIND_DIRECTORY[kind]}/${assertRecordId(id, 'Page id')}.md`;
}

export function historyRelativePath(kind: PageKind, id: string, revision: string): string {
  return `${HISTORY_DIRECTORY}/${KIND_DIRECTORY[kind]}/${assertRecordId(id, 'Page id')}/${assertSafeRevision(revision, 'Revision')}.md`;
}

/** Source originals are stored under a filename derived from their media type, never from caller text. */
export function sourceExtension(mediaType: string): string {
  const subtype = mediaType.split(';')[0]?.split('/')[1] ?? '';
  const cleaned = subtype.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return cleaned ? cleaned.slice(0, 12) : 'bin';
}

export function rawRelativePath(sourceId: string, revision: string, mediaType: string): string {
  return `${RAW_DIRECTORY}/${assertRecordId(sourceId, 'Source id')}/${assertSafeRevision(revision, 'Source revision')}.${sourceExtension(mediaType)}`;
}

export function isRawPath(relativePath: string): boolean {
  return relativePath === RAW_DIRECTORY || relativePath.startsWith(`${RAW_DIRECTORY}/`);
}
