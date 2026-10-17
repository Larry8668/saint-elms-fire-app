import { z } from 'zod';
import { ContractVersionSchema, IdentifierSchema, ProfileIdentitySchema, RevisionSchema, Sha256Schema, TimestampSchema } from './contracts';

/**
 * Vault portability: the versioned export a student can carry away and the preview/result
 * shapes a restore produces. The archive holds only the student's own knowledge — pages,
 * history, source records and originals, the growth ledger and erasure tombstones. Device,
 * session, provider and entitlement material never enters it, and nothing in it is trusted:
 * every file carries its hash and import re-checks each one in code.
 */

export const VAULT_EXPORT_VERSION = 1 as const;
export const VAULT_EXPORT_KIND = 'sef-vault-export' as const;

/** One vault file, verbatim: its path is vault-relative and its hash covers the decoded bytes. */
export const VaultExportFileSchema = z.strictObject({
  path: z.string().min(1).max(600),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
});
export type VaultExportFile = z.infer<typeof VaultExportFileSchema>;

export const VaultExportCountsSchema = z.strictObject({
  pages: z.number().int().nonnegative(),
  history: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  tombstones: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type VaultExportCounts = z.infer<typeof VaultExportCountsSchema>;

export const VaultExportSchema = z.strictObject({
  schemaVersion: z.literal(VAULT_EXPORT_VERSION),
  kind: z.literal(VAULT_EXPORT_KIND),
  createdAt: TimestampSchema,
  /** The vault layout the export was taken from; a restore refuses anything newer. */
  layout: z.number().int().positive(),
  /**
   * Who produced the export — provenance for the preview, never adopted on import:
   * restoring a vault cannot confer this identity or any enrolment on the destination.
   */
  exportedBy: ProfileIdentitySchema,
  counts: VaultExportCountsSchema,
  files: z.array(VaultExportFileSchema),
  /** Vault paths deliberately left out (unsafe names, unselected originals) — silence would hide them. */
  skipped: z.array(z.string()),
});
export type VaultExport = z.infer<typeof VaultExportSchema>;

/** POST /api/vault/export — optionally narrow which sources carry their original bytes. */
export const VaultExportRequestSchema = z.strictObject({
  sourceIds: z.array(IdentifierSchema).max(2000).optional(),
});
export type VaultExportRequest = z.infer<typeof VaultExportRequestSchema>;

/**
 * What an erasure leaves behind: enough for a future sync to propagate the delete without
 * keeping any of the source's content. The raw bytes and the record are gone; this is the
 * honest marker that they once existed and were removed by the student.
 */
export const SourceTombstoneSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  revision: RevisionSchema,
  kind: z.enum(['note', 'document', 'image', 'audio', 'session', 'answer', 'peer']),
  mediaType: z.string().min(1).max(120),
  sha256: Sha256Schema,
  erasedAt: TimestampSchema,
});
export type SourceTombstone = z.infer<typeof SourceTombstoneSchema>;

/** GET /api/sources/:id/dependents — what still cites a source before the student erases it. */
export const SourceDependentsSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  sourceId: IdentifierSchema,
  pages: z.array(
    z.strictObject({
      id: IdentifierSchema,
      kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
      title: z.string(),
      /** Where the page leans on the source: 'page', 'claim <id>', 'link → <id>', 'learner evidence'. */
      references: z.array(z.string().min(1)),
    }),
  ),
});
export type SourceDependents = z.infer<typeof SourceDependentsSchema>;

export const SourceEraseRequestSchema = z.strictObject({
  expectedRevision: RevisionSchema.optional(),
});
export type SourceEraseRequest = z.infer<typeof SourceEraseRequestSchema>;

export const SourceEraseResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  erased: z.boolean(),
  /** The dependents as they stood at erase time — the deletion is honest about what it orphaned. */
  dependents: SourceDependentsSchema.shape.pages,
});
export type SourceEraseResult = z.infer<typeof SourceEraseResultSchema>;

/** Where an archived file belongs in the vault — anything else is refused before a byte is written. */
export const ARCHIVE_AREAS = ['page', 'history', 'source_record', 'source_extracted', 'raw', 'event', 'tombstone', 'log'] as const;
export type ArchiveArea = (typeof ARCHIVE_AREAS)[number];

export const IMPORT_CONFLICT_REASONS = [
  'different_revision',
  'different_bytes',
  'moved',
  'newer_schema',
  'malformed',
  'missing_bytes',
] as const;
export type ImportConflictReason = (typeof IMPORT_CONFLICT_REASONS)[number];

/** One place the import and the destination disagree — listed, never silently resolved. */
export const VaultImportConflictSchema = z.strictObject({
  area: z.enum(ARCHIVE_AREAS),
  path: z.string().min(1),
  /** The page or source id when the file names one. */
  id: IdentifierSchema.optional(),
  reason: z.enum(IMPORT_CONFLICT_REASONS),
  /** What the destination holds now — a revision for pages, a sha for immutable files. */
  existing: z.string().nullable(),
  /** What the archive carries. */
  imported: z.string().nullable(),
  /** True only for page overwrites the student may explicitly choose; immutable files can never be forced. */
  resolvable: z.boolean(),
});
export type VaultImportConflict = z.infer<typeof VaultImportConflictSchema>;

export const VaultImportPlanSchema = z.strictObject({
  writeFiles: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  createPages: z.array(IdentifierSchema),
  sources: z.strictObject({
    create: z.array(IdentifierSchema),
    update: z.array(IdentifierSchema),
    skip: z.array(z.strictObject({ id: IdentifierSchema, reason: z.string() })),
  }),
  events: z.strictObject({ create: z.number().int().nonnegative(), skip: z.number().int().nonnegative() }),
  history: z.strictObject({ write: z.number().int().nonnegative(), skip: z.number().int().nonnegative() }),
  tombstones: z.strictObject({ create: z.number().int().nonnegative(), skip: z.number().int().nonnegative() }),
  /** Learning-log blocks the merge would append. */
  logEntries: z.number().int().nonnegative(),
  /** Archived files already on disk byte-for-byte. */
  unchanged: z.number().int().nonnegative(),
});
export type VaultImportPlan = z.infer<typeof VaultImportPlanSchema>;

/** POST /api/vault/import/preview — what a restore would do, computed before any write. */
export const VaultImportPreviewSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  state: z.enum(['ready', 'conflicts', 'refused']),
  /** Why an archive was refused — 'malformed', 'newer_schema', 'unsafe', 'integrity', 'too_large'. */
  code: z.string().optional(),
  reason: z.string().optional(),
  archive: z
    .strictObject({
      createdAt: TimestampSchema,
      exportedBy: ProfileIdentitySchema,
      layout: z.number().int().positive(),
      counts: VaultExportCountsSchema,
    })
    .optional(),
  destination: z.strictObject({ pages: z.number().int().nonnegative(), sources: z.number().int().nonnegative() }).optional(),
  conflicts: z.array(VaultImportConflictSchema),
  plan: VaultImportPlanSchema.optional(),
  warnings: z.array(z.string()),
});
export type VaultImportPreview = z.infer<typeof VaultImportPreviewSchema>;

/** POST /api/vault/import/preview and /import bodies. The archive is re-validated inside; nothing here is trusted. */
export const VaultImportRequestSchema = z.strictObject({ archive: z.unknown() });
export const VaultRestoreRequestSchema = z.strictObject({
  archive: z.unknown(),
  /** Page ids the student chose to overwrite — only resolvable conflicts honour it. */
  overwritePageIds: z.array(IdentifierSchema).max(10_000).optional(),
});
export type VaultRestoreRequest = z.infer<typeof VaultRestoreRequestSchema>;

export const VaultImportResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  committed: z.boolean(),
  journalId: z.string().nullable(),
  applied: z.strictObject({
    pages: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    rawFiles: z.number().int().nonnegative(),
    history: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    tombstones: z.number().int().nonnegative(),
    logEntries: z.number().int().nonnegative(),
  }),
  skipped: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
  /** Conflicts the restore left alone because the student did not resolve them. */
  conflicts: z.array(VaultImportConflictSchema),
});
export type VaultImportResult = z.infer<typeof VaultImportResultSchema>;
