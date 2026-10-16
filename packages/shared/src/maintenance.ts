import { z } from 'zod';
import { EdgeTypeSchema } from './brain';
import { ContractVersionSchema, IdentifierListSchema, IdentifierSchema, RevisionSchema, TimestampSchema } from './contracts';
import { DroppedItemSchema } from './wiki';

/**
 * Wiki maintenance findings — what the lint pass and the bounded semantic review report.
 *
 * Deterministic findings are recomputed from the vault on every call. Semantic findings are
 * drafted by a model, validated in code (every reference must resolve), persisted until the
 * pages they cite change, and are always suggestions: nothing here rewrites a page. A fix
 * travels as a code-built WikiProposal the student reviews and accepts like any other.
 */

/** Structural checks the deterministic pass runs alongside the learner-facing lint. */
export const STRUCTURAL_FINDING_KINDS = [
  /** Nothing links to this page and it links nowhere — an island in the wiki. */
  'orphan',
  /** sourceIds or learner evidence point at a source that was erased or never kept. */
  'missing_source',
  /** A claim cites a source that was erased or never kept. */
  'missing_citation',
  /** A typed link targets a page that does not exist. */
  'dead_link',
  /** A [[page]] mention in the body never became a typed link. */
  'unrecorded_link',
  /** index.md does not list this page, lists a stale revision, or lists a page that is gone. */
  'unindexed',
  /** The course mapping disagrees with the course sky. */
  'bad_mapping',
  /** The page file is over the size ceiling. */
  'oversized',
  /** The file is unreadable, written by a newer engine, in the earlier format, or internally inconsistent. */
  'schema_issue',
  /** The file changed outside the keeper — its stamped revision no longer matches its content. */
  'revision_drift',
] as const;
export type StructuralFindingKind = (typeof STRUCTURAL_FINDING_KINDS)[number];

/** What the bounded semantic review may suggest. */
export const SEMANTIC_FINDING_KINDS = [
  /** Two standing claims appear to disagree — both sides are cited. */
  'contradiction',
  /** A claim another claim has likely replaced. */
  'stale_claim',
  /** Two pages that should probably be linked. */
  'missing_connection',
  /** An open question worth pursuing on a page. */
  'open_question',
] as const;
export type SemanticFindingKind = (typeof SEMANTIC_FINDING_KINDS)[number];

export const FINDING_KINDS = [...STRUCTURAL_FINDING_KINDS, ...SEMANTIC_FINDING_KINDS] as const;
export const FindingKindSchema = z.enum(FINDING_KINDS);
export type FindingKind = z.infer<typeof FindingKindSchema>;

/** One piece of evidence behind a finding — a page, and where relevant a claim on it. */
export const FindingEvidenceSchema = z.strictObject({
  pageId: IdentifierSchema,
  claimId: IdentifierSchema.optional(),
  /** What this evidence shows, phrased for the student. */
  note: z.string().min(1).max(500),
});
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

/**
 * What accepting a finding would do. `suggestion` findings have no mechanical fix — they are
 * shown, discussed and dismissed, never applied. The rest name a code-decided repair; the
 * proposal builder turns them into ordinary wiki operations.
 */
export const MaintenanceActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('suggestion') }),
  /** Regenerate index.md and the manifest from the pages on disk; no page is rewritten. */
  z.strictObject({ kind: z.literal('rebuild_catalogue') }),
  /** Link two existing pages. */
  z.strictObject({
    kind: z.literal('add_link'),
    fromPageId: IdentifierSchema,
    toPageId: IdentifierSchema,
    linkType: EdgeTypeSchema,
    why: z.string().min(1).max(600),
  }),
  /** Rewrite one page's metadata with a code-built correction. */
  z.strictObject({
    kind: z.literal('repair_page'),
    pageId: IdentifierSchema,
    repair: z.enum([
      /** Recompute courseRefs from the course sky. */
      'course_mapping',
      /** Drop sourceIds and citations that name erased sources; claims left unsupported are removed. */
      'dead_source_refs',
      /** Drop typed links that target pages which do not exist. */
      'dead_links',
      /** Adopt a page still in the earlier format into the typed schema, content kept verbatim. */
      'adopt_schema',
      /** Accept the on-disk content as the canonical revision — the edit made outside the keeper stands. */
      'adopt_drift',
      /** Mark one claim superseded by another claim on the same page. */
      'supersede_claim',
      /** Mark a claim disputed; with otherPageId/otherClaimId the other side is marked too. */
      'dispute_claim',
      /** Append an open-question claim drafted by the semantic review. */
      'append_question',
    ]),
    claimId: IdentifierSchema.optional(),
    otherPageId: IdentifierSchema.optional(),
    otherClaimId: IdentifierSchema.optional(),
    /** The text an append_question repair adds. */
    text: z.string().max(600).optional(),
  }),
]);
export type MaintenanceAction = z.infer<typeof MaintenanceActionSchema>;

export const MaintenanceFindingSchema = z.strictObject({
  /** Stable id derived from the finding's content — re-runs dedupe and dismissals stick. */
  id: IdentifierSchema,
  /** 'deterministic' checks recompute every call; 'semantic' findings come from the bounded review. */
  origin: z.enum(['deterministic', 'semantic']),
  kind: FindingKindSchema,
  /** Every page the finding concerns — both sides of a contradiction are listed. */
  pageIds: IdentifierListSchema,
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(1200),
  evidence: z.array(FindingEvidenceSchema).max(8),
  action: MaintenanceActionSchema,
  /** The revision each page sat at when the check ran; a later edit makes the finding stale. */
  revisions: z.record(IdentifierSchema, RevisionSchema),
  /** A Socratic opener when the right next step is thinking, not editing. */
  prompt: z.string().max(600).optional(),
});
export type MaintenanceFinding = z.infer<typeof MaintenanceFindingSchema>;

/** GET /api/brain/maintenance — the current findings plus where the semantic review stands. */
export const MaintenanceReportSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  checkedAt: TimestampSchema,
  findings: z.array(MaintenanceFindingSchema),
  /** Findings suppressed because the student dismissed them earlier. */
  dismissed: z.number().int().nonnegative(),
  semantic: z.strictObject({
    state: z.enum(['never_run', 'ran', 'failed']),
    lastRunAt: TimestampSchema.nullable(),
    model: z.string().nullable(),
    note: z.string().max(400).optional(),
  }),
});
export type MaintenanceReport = z.infer<typeof MaintenanceReportSchema>;

/** POST /api/brain/maintenance/review — a completed bounded review pass. */
export const SemanticReviewResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  checkedAt: TimestampSchema,
  model: z.string(),
  durationMs: z.number().nonnegative(),
  pagesReviewed: z.number().int().nonnegative(),
  findings: z.array(MaintenanceFindingSchema),
  /** Draft entries that failed validation, with the reason — suggestions are never silently fixed up. */
  dropped: z.array(DroppedItemSchema),
});
export type SemanticReviewResult = z.infer<typeof SemanticReviewResultSchema>;

/** POST /api/brain/maintenance/proposals — the filed repair proposal, or what fell out. */
export const MaintenanceProposalResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  proposalId: IdentifierSchema.nullable(),
  /** Findings that became operations in the filed proposal. */
  filed: IdentifierListSchema,
  skipped: z.array(z.strictObject({ findingId: IdentifierSchema, reason: z.string().max(400) })),
});
export type MaintenanceProposalResult = z.infer<typeof MaintenanceProposalResultSchema>;

/** POST /api/brain/maintenance/catalogue — the journaled index/manifest rebuild. */
export const CatalogueRepairResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  changed: z.boolean(),
  pagesIndexed: z.number().int().nonnegative(),
});
export type CatalogueRepairResult = z.infer<typeof CatalogueRepairResultSchema>;
