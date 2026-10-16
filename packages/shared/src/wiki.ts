import { z } from 'zod';
import {
  ContractVersionSchema,
  HttpUrlSchema,
  IdentifierSchema,
  IdentifierListSchema,
  NonemptyIdentifiersSchema,
  ProfileIdentitySchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
} from './contracts';
import { EDGE_TYPES } from './brain';
import { TEACHER_IDS } from './teachers';

export const SourceLocatorSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({ kind: z.literal('text'), start: z.number().int().nonnegative(), end: z.number().int().positive() })
    .refine((v) => v.end > v.start, 'Invalid text range'),
  z.strictObject({ kind: z.literal('pdf'), page: z.number().int().positive(), excerpt: z.string().min(1) }),
  z.strictObject({ kind: z.literal('image'), extractionRevision: RevisionSchema, excerpt: z.string().min(1) }),
  z
    .strictObject({
      kind: z.literal('session'),
      firstTurn: z.number().int().nonnegative(),
      lastTurn: z.number().int().nonnegative(),
    })
    .refine((v) => v.lastTurn >= v.firstTurn, 'Invalid inclusive turn range'),
]);
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

export const SourceCitationSchema = z.strictObject({
  sourceId: IdentifierSchema,
  sourceRevision: RevisionSchema,
  sha256: Sha256Schema,
  locator: SourceLocatorSchema,
});
export type SourceCitation = z.infer<typeof SourceCitationSchema>;

export const CourseConceptRefSchema = z.strictObject({
  programmeId: IdentifierSchema,
  courseId: IdentifierSchema,
  conceptKey: IdentifierSchema,
  lessonId: IdentifierSchema.optional(),
});
export type CourseConceptRef = z.infer<typeof CourseConceptRefSchema>;

/** How a source's text was produced — the last ledger entry is the text a compile would read. */
export const ExtractionMethodSchema = z.enum(['text', 'pdf', 'vision', 'student_correction']);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

const sourceBase = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  profile: ProfileIdentitySchema,
  revision: RevisionSchema,
  title: z.string().trim().min(1).max(300),
  createdAt: TimestampSchema,
  mediaType: z.string().min(1).max(120),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  attribution: z.strictObject({ creator: z.string().max(300).optional(), url: HttpUrlSchema.optional() }),
  extractions: z.array(
    z.strictObject({
      revision: RevisionSchema,
      method: ExtractionMethodSchema,
      sha256: Sha256Schema,
      createdAt: TimestampSchema,
      /** Characters of text the pass produced; absent on records written before it was tracked. */
      chars: z.number().int().nonnegative().optional(),
      /** Whether that pass stopped short of the whole source. */
      partial: z.boolean().optional(),
      /** Why a pass stopped short or produced nothing; absent on records written before notes were kept. */
      note: z.string().max(500).optional(),
    }),
  ),
});

const sessionRef = z
  .strictObject({
    sessionId: IdentifierSchema,
    teacher: z.enum(TEACHER_IDS),
    firstTurn: z.number().int().nonnegative(),
    lastTurn: z.number().int().nonnegative(),
  })
  .refine((v) => v.lastTurn >= v.firstTurn, 'Invalid inclusive turn range');

export const SourceRecordSchema = z.discriminatedUnion('kind', [
  sourceBase.extend({ kind: z.literal('note'), origin: z.literal('student') }),
  sourceBase.extend({ kind: z.literal('document'), origin: z.enum(['course', 'external']) }),
  sourceBase.extend({ kind: z.literal('image'), origin: z.enum(['student', 'external']) }),
  sourceBase.extend({ kind: z.literal('session'), origin: z.literal('student'), session: sessionRef }),
  sourceBase.extend({ kind: z.literal('answer'), origin: z.literal('model'), session: sessionRef }),
  sourceBase.extend({
    kind: z.literal('peer'),
    origin: z.literal('peer'),
    share: z.strictObject({
      id: IdentifierSchema,
      revision: RevisionSchema,
      senderId: IdentifierSchema,
      cohortId: IdentifierSchema,
    }),
  }),
]);
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const WikiClaimSchema = z
  .strictObject({
    id: IdentifierSchema,
    text: z.string().min(1),
    kind: z.enum(['source_fact', 'student_belief', 'deduction', 'question']),
    origin: z.enum(['course', 'external', 'student', 'peer', 'model']),
    status: z.enum(['current', 'superseded', 'disputed']),
    citations: z.array(SourceCitationSchema),
    supersedes: IdentifierListSchema,
  })
  .superRefine((value, ctx) => {
    if ((value.kind === 'source_fact' || value.kind === 'student_belief') && !value.citations.length) {
      ctx.addIssue({ code: 'custom', path: ['citations'], message: 'Facts and student beliefs require evidence' });
    }
  });
export type WikiClaim = z.infer<typeof WikiClaimSchema>;

export const WikiLinkSchema = z
  .strictObject({
    toPageId: IdentifierSchema,
    type: z.enum(EDGE_TYPES),
    origin: z.enum(['course', 'student', 'peer', 'suggested']),
    why: z.string().min(1),
    citations: z.array(SourceCitationSchema),
  })
  .superRefine((value, ctx) => {
    if (value.origin === 'student' && !value.citations.length) {
      ctx.addIssue({ code: 'custom', path: ['citations'], message: 'Student-made connections require evidence' });
    }
  });
export type WikiLink = z.infer<typeof WikiLinkSchema>;

const pageBase = z.strictObject({
  id: IdentifierSchema,
  title: z.string().min(1).max(300),
  summary: z.string().min(1),
  markdown: z.string(),
  courseRefs: z.array(CourseConceptRefSchema),
  claims: z.array(WikiClaimSchema),
  links: z.array(WikiLinkSchema),
});

export const WikiPageDraftSchema = z.discriminatedUnion('kind', [
  pageBase.extend({
    kind: z.literal('concept'),
    learner: z.strictObject({
      inMyWords: z.string(),
      stuck: z.string(),
      connections: z.string(),
      evidenceIds: IdentifierListSchema,
    }),
  }),
  pageBase.extend({ kind: z.literal('source_summary'), sourceIds: NonemptyIdentifiersSchema }),
  pageBase.extend({ kind: z.literal('synthesis'), sourceIds: NonemptyIdentifiersSchema }),
  pageBase.extend({ kind: z.literal('question'), sourceIds: IdentifierListSchema }),
]);
export type WikiPageDraft = z.infer<typeof WikiPageDraftSchema>;

export const WikiPageSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  profile: ProfileIdentitySchema,
  revision: RevisionSchema,
  state: z.literal('committed'),
  updatedAt: TimestampSchema,
  page: WikiPageDraftSchema,
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiEditSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('upsert_page'), page: WikiPageDraftSchema }),
  z.strictObject({ op: z.literal('add_link'), fromPageId: IdentifierSchema, link: WikiLinkSchema }),
]);
export type WikiEdit = z.infer<typeof WikiEditSchema>;

export const WikiProposalSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    id: IdentifierSchema,
    profile: ProfileIdentitySchema,
    sourceIds: NonemptyIdentifiersSchema,
    conventionRevision: RevisionSchema,
    createdAt: TimestampSchema,
    baseRevisions: z.record(IdentifierSchema, RevisionSchema.nullable()),
    operations: z.array(WikiEditSchema).min(1),
  })
  .superRefine((value, ctx) => {
    value.operations.forEach((op, index) => {
      const id = op.op === 'upsert_page' ? op.page.id : op.fromPageId;
      if (!Object.hasOwn(value.baseRevisions, id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index],
          message: 'Each edited page needs an expected base revision; null means create',
        });
      }
    });
  });
export type WikiProposal = z.infer<typeof WikiProposalSchema>;

export const WikiJobSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    id: IdentifierSchema,
    profile: ProfileIdentitySchema,
    sourceIds: NonemptyIdentifiersSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    stage: z.enum([
      'queued',
      'extracting',
      'awaiting_source_review',
      'compiling',
      'awaiting_review',
      'committed',
      'no_changes',
      'failed',
      'cancelled',
    ]),
    progress: z
      .strictObject({ completed: z.number().int().nonnegative(), total: z.number().int().positive() })
      .refine((v) => v.completed <= v.total, 'Progress exceeds total'),
    proposalId: IdentifierSchema.nullable(),
    error: z.string().min(1).max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Update precedes job creation' });
    }
    if ((value.stage === 'failed') !== (value.error !== null)) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: 'Only failed jobs carry an error' });
    }
    if ((value.stage === 'awaiting_review' || value.stage === 'committed') && !value.proposalId) {
      ctx.addIssue({ code: 'custom', path: ['proposalId'], message: 'Review or commit requires a proposal' });
    }
  });
export type WikiJob = z.infer<typeof WikiJobSchema>;

export const PROPOSAL_STATES = ['pending', 'accepted', 'rejected'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** A draft entry the deterministic pass dropped, with the reason it was refused. */
export const DroppedItemSchema = z.strictObject({ what: z.string(), reason: z.string() });
export type DroppedItem = z.infer<typeof DroppedItemSchema>;

/**
 * A proposal plus its review outcome. The proposal body itself is immutable once filed —
 * the review decision lives beside it, never inside it, so a re-read always shows exactly
 * what the keeper drafted.
 */
export const WikiProposalRecordSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    proposal: WikiProposalSchema,
    /** The source job that produced it; null for code-built proposals (e.g. quiz evidence). */
    jobId: IdentifierSchema.nullable(),
    state: z.enum(PROPOSAL_STATES),
    decidedAt: TimestampSchema.nullable(),
    /** 'student' for an explicit review choice; 'system' for code-built proposals (e.g. quiz evidence). */
    decidedBy: z.enum(['student', 'system']).nullable(),
    note: z.string().max(500).optional(),
    /** What the deterministic pass dropped on the way to this proposal — part of what a review sees. */
    dropped: z.array(DroppedItemSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.state === 'pending') !== (value.decidedAt === null && value.decidedBy === null)) {
      ctx.addIssue({ code: 'custom', path: ['decidedAt'], message: 'Only pending proposals lack a decision' });
    }
  });
export type WikiProposalRecord = z.infer<typeof WikiProposalRecordSchema>;

/** The review queue the contribution UI renders. */
export const ProposalListSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  proposals: z.array(WikiProposalRecordSchema),
  /** Proposals still waiting on a decision. */
  pending: z.number().int().nonnegative(),
});
export type ProposalList = z.infer<typeof ProposalListSchema>;

/** What a proposal would do if accepted, computed fresh — never trusted from storage. */
export const ProposalPreviewSchema = z.strictObject({
  record: WikiProposalRecordSchema,
  pages: z.array(
    z.strictObject({
      id: IdentifierSchema,
      kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
      change: z.enum(['created', 'updated', 'unchanged']),
      title: z.string(),
      summaryBefore: z.string().optional(),
      summaryAfter: z.string(),
      /** Claims and links this proposal would add on top of the page's current state. */
      addedClaims: z.array(WikiClaimSchema),
      addedLinks: z.array(WikiLinkSchema),
    }),
  ),
  conflicts: z.array(z.string()),
});
export type ProposalPreview = z.infer<typeof ProposalPreviewSchema>;

/** What the engine reports about one source to the desktop and admin apps. */
export const SourceSummarySchema = z.strictObject({
  id: IdentifierSchema,
  revision: RevisionSchema,
  title: z.string().min(1).max(300),
  kind: z.enum(['note', 'document', 'image', 'session', 'answer', 'peer']),
  mediaType: z.string().min(1).max(120),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  /** True once something has been read out of it; false while it is still opaque. */
  extracted: z.boolean(),
  /** True when the extraction stopped early — the reason travels with it. */
  partial: z.boolean().default(false),
  /** Human-readable explanation for a partial or failed extraction. */
  note: z.string().max(500).optional(),
  capturedAt: TimestampSchema,
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

/** The ingestion job list the UI renders. */
export const JobListSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  jobs: z.array(WikiJobSchema),
  sources: z.array(SourceSummarySchema),
  /** Non-terminal jobs, so a client can explain the cap without recomputing. */
  activeJobs: z.number().int().nonnegative(),
});
export type JobList = z.infer<typeof JobListSchema>;

/** What POST /api/sources returns: the source is retained before anything reads it. */
export const SourceReceiptSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  source: SourceSummarySchema,
  extraction: z
    .strictObject({
      method: ExtractionMethodSchema,
      text: z.string(),
      partial: z.boolean(),
      note: z.string().optional(),
    })
    .nullable(),
  jobId: IdentifierSchema,
  /** True when the same material or a live covering job was already on file. */
  reused: z.boolean(),
});
export type SourceReceipt = z.infer<typeof SourceReceiptSchema>;

/**
 * One retained source in full: the immutable record, the latest extraction pass (the text a
 * compile would read and a correction replaces), and the newest job covering it.
 */
export const SourceDetailSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  record: SourceRecordSchema,
  extraction: z
    .strictObject({
      method: ExtractionMethodSchema,
      text: z.string(),
      partial: z.boolean(),
      note: z.string().optional(),
      at: TimestampSchema,
    })
    .nullable(),
  job: WikiJobSchema.nullable(),
});
export type SourceDetail = z.infer<typeof SourceDetailSchema>;

/** POST /api/sources/:id/read — a fresh vision pass over a kept image, recorded as its extraction. */
export const SourceReadResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  detail: SourceDetailSchema,
  reading: z.strictObject({ topic: z.string(), transcription: z.string(), concepts: z.array(z.string()) }),
});
export type SourceReadResult = z.infer<typeof SourceReadResultSchema>;

/** One page touched by an applied proposal. */
export const PageChangeReportSchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
  change: z.enum(['created', 'updated', 'unchanged']),
  revisionBefore: z.string().nullable(),
  revisionAfter: z.string(),
});
export type PageChangeReport = z.infer<typeof PageChangeReportSchema>;

/** The journaled outcome of an accepted proposal. */
export const ProposalReportSchema = z.strictObject({
  proposalId: IdentifierSchema,
  committed: z.boolean(),
  journalId: z.string().nullable(),
  pages: z.array(PageChangeReportSchema),
  logEntry: z.strictObject({ at: TimestampSchema, kind: z.string(), title: z.string(), detail: z.string().optional() }),
});
export type ProposalReport = z.infer<typeof ProposalReportSchema>;

/** POST /api/sources/:jobId/compile — the job's new stage plus the proposal it filed. */
export const CompileResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  job: WikiJobSchema,
  proposalId: IdentifierSchema.nullable(),
  dropped: z.array(DroppedItemSchema),
  model: z.string(),
  durationMs: z.number(),
});
export type CompileResult = z.infer<typeof CompileResultSchema>;

/** Every saved revision of one page: the current file plus the .history/ snapshots. */
export const PageRevisionListSchema = z.strictObject({
  pageId: IdentifierSchema,
  current: RevisionSchema.nullable(),
  revisions: z.array(z.strictObject({ revision: z.string(), at: TimestampSchema, current: z.boolean() })),
});
export type PageRevisionList = z.infer<typeof PageRevisionListSchema>;

/** One revision's page file exactly as it committed — frontmatter included. */
export const PageRevisionContentSchema = z.strictObject({
  pageId: IdentifierSchema,
  revision: z.string(),
  raw: z.string(),
  current: z.boolean(),
});
export type PageRevisionContent = z.infer<typeof PageRevisionContentSchema>;

export const LearningEventSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    id: IdentifierSchema,
    profile: ProfileIdentitySchema,
    pageId: IdentifierSchema,
    at: TimestampSchema,
    kind: z.enum(['encounter', 'explanation', 'struggle', 'correction', 'connection', 'application', 'review']),
    actor: z.enum(['student', 'peer', 'model']),
    evidence: z.array(SourceCitationSchema).min(1),
    knowledgeOnly: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.actor !== 'student' && !value.knowledgeOnly) {
      ctx.addIssue({
        code: 'custom',
        path: ['knowledgeOnly'],
        message: 'Imported or generated knowledge is not evidence of student mastery',
      });
    }
  });
export type LearningEvent = z.infer<typeof LearningEventSchema>;
