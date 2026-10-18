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
import { EDGE_TYPES, EdgeTypeSchema } from './brain';
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
export const ExtractionMethodSchema = z.enum(['text', 'pdf', 'vision', 'audio', 'video', 'student_correction']);
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

/** Where a fetched video source actually came from — kept verbatim, never re-derived. */
export const SourceLinkSchema = z.strictObject({
  provider: z.literal('youtube'),
  /** The canonical watch URL the fetch ran against. */
  url: HttpUrlSchema,
  videoId: z.string().min(1).max(40),
  fetchedAt: TimestampSchema,
});
export type SourceLink = z.infer<typeof SourceLinkSchema>;

export const SourceRecordSchema = z.discriminatedUnion('kind', [
  sourceBase.extend({ kind: z.literal('note'), origin: z.literal('student') }),
  sourceBase.extend({ kind: z.literal('document'), origin: z.enum(['course', 'external']) }),
  sourceBase.extend({ kind: z.literal('image'), origin: z.enum(['student', 'external']) }),
  sourceBase.extend({ kind: z.literal('audio'), origin: z.enum(['student', 'external']) }),
  /**
   * Two lanes share the kind: a fetched link (always external, its audio track kept, the
   * link frozen beside it) and an uploaded file (the student's own recording or someone
   * else's, the video bytes kept, no link). The ingest path pins which lane is which.
   */
  sourceBase
    .extend({ kind: z.literal('video'), origin: z.enum(['student', 'external']), link: SourceLinkSchema.optional() })
    .superRefine((value, ctx) => {
      if (value.link && value.origin !== 'external') {
        ctx.addIssue({ code: 'custom', path: ['origin'], message: 'A fetched video is always external material' });
      }
      if (!value.link && !value.mediaType.trim().toLowerCase().startsWith('video/')) {
        ctx.addIssue({ code: 'custom', path: ['link'], message: 'A video kept as its audio track must carry the link it was fetched from' });
      }
    }),
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
  /**
   * Maintenance edits need removal too: the link union on upsert can only grow, so a dead
   * link is deleted by its own op. `linkType` narrows the match when several links share a target.
   */
  z.strictObject({
    op: z.literal('remove_link'),
    fromPageId: IdentifierSchema,
    toPageId: IdentifierSchema,
    linkType: EdgeTypeSchema.optional(),
  }),
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
      // A model read (recording, video, photo) running in the background after the upload answered.
      'reading',
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
      /** Links the proposal would take away — maintenance repairs remove links too. */
      removedLinks: z.array(WikiLinkSchema).default([]),
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
  kind: z.enum(['note', 'document', 'image', 'audio', 'video', 'session', 'answer', 'peer']),
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

export const LEARNING_EVENT_KINDS = ['encounter', 'explanation', 'struggle', 'correction', 'connection', 'application', 'review'] as const;
export type LearningEventKind = (typeof LEARNING_EVENT_KINDS)[number];

export const LEARNING_EVENT_ACTORS = ['student', 'peer', 'model'] as const;
export type LearningEventActor = (typeof LEARNING_EVENT_ACTORS)[number];

/**
 * Evidence a growth event points at when a verbatim citation is not the right shape:
 * the vault source the material came from, a durable artifact (a stored quiz result,
 * a proposal id), or the page revision the event committed. The revision ref is what
 * makes an event reproducible — replaying the same content yields the same event.
 */
export const EventRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), ref: IdentifierSchema, revision: RevisionSchema }),
  z.strictObject({ kind: z.literal('artifact'), ref: IdentifierSchema }),
  z.strictObject({ kind: z.literal('revision'), ref: RevisionSchema }),
]);
export type EventRef = z.infer<typeof EventRefSchema>;

export const EventEvidenceSchema = z.union([SourceCitationSchema, EventRefSchema]);
export type EventEvidence = z.infer<typeof EventEvidenceSchema>;

/**
 * One catalogue row of the compiled wiki, for GET /api/wiki/pages. Metadata only — the
 * page body comes from the view endpoint, so an index read stays cheap on a large vault.
 */
export const WikiPageEntrySchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
  title: z.string(),
  summary: z.string(),
  revision: RevisionSchema,
  updatedAt: TimestampSchema.nullable(),
  /** 'out_of_band' or 'malformed' means the file on disk no longer matches its frontmatter. */
  state: z.enum(['ok', 'out_of_band', 'malformed', 'newer_schema']),
  sourceIds: IdentifierListSchema,
  claims: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
});
export type WikiPageEntry = z.infer<typeof WikiPageEntrySchema>;

/** Which retrieval lane admitted a hit: the keyword scorer, the embedding index, or both. */
export const SearchMatchKindSchema = z.enum(['keyword', 'semantic', 'both']);
export type SearchMatchKind = z.infer<typeof SearchMatchKindSchema>;

/** Which retrieval produced the answer set — 'keyword_only' means the embedding lane could not run. */
export const SearchModeSchema = z.enum(['hybrid', 'keyword_only']);
export type SearchMode = z.infer<typeof SearchModeSchema>;

/** A catalogue row that came back from search — the entry plus how it was found. */
export const WikiPageHitSchema = WikiPageEntrySchema.extend({
  score: z.number(),
  match: SearchMatchKindSchema,
});
export type WikiPageHit = z.infer<typeof WikiPageHitSchema>;

export const WikiIndexSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  counts: z.strictObject({
    pages: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    byKind: z.record(z.enum(['concept', 'source_summary', 'synthesis', 'question']), z.number().int().nonnegative()),
  }),
  pages: z.array(WikiPageEntrySchema),
});
export type WikiIndex = z.infer<typeof WikiIndexSchema>;

/**
 * The wiki as a compact graph, for GET /api/wiki/graph: one node per readable page and one
 * edge per link whose target page exists. Derived from the same snapshots as the index and
 * read-only — it exists so a visualization of a 1,000+ page vault is one request, not one
 * per page. Mastery status is not repeated here; it comes from /api/brain/records.
 */
export const WikiGraphNodeSchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
  title: z.string(),
  summary: z.string(),
  updatedAt: TimestampSchema.nullable(),
  claims: z.number().int().nonnegative(),
  /** The claims' text, so a client-side search can reach what a page asserts, not only its title. */
  claimTexts: z.array(z.string()),
  sourceIds: IdentifierListSchema,
  /** Distinct course ids the page is anchored to, in first-seen order. */
  courseIds: z.array(z.string()),
});
export type WikiGraphNode = z.infer<typeof WikiGraphNodeSchema>;

export const WikiGraphEdgeSchema = z.strictObject({
  source: IdentifierSchema,
  target: IdentifierSchema,
  type: z.enum(EDGE_TYPES),
  origin: z.enum(['course', 'student', 'peer', 'suggested']),
});
export type WikiGraphEdge = z.infer<typeof WikiGraphEdgeSchema>;

export const WikiGraphSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  nodes: z.array(WikiGraphNodeSchema),
  edges: z.array(WikiGraphEdgeSchema),
});
export type WikiGraph = z.infer<typeof WikiGraphSchema>;

/**
 * One claim as the engine judges it right now: assertable means its provenance resolves
 * against the vault's current sources; a withheld claim may be named, never asserted.
 */
export const WikiClaimViewSchema = z.strictObject({
  id: IdentifierSchema,
  text: z.string(),
  kind: z.enum(['source_fact', 'student_belief', 'deduction', 'question']),
  origin: z.enum(['course', 'external', 'student', 'peer', 'model']),
  status: z.enum(['current', 'superseded', 'disputed']),
  assertable: z.boolean(),
  reason: z.string().optional(),
  citations: z.array(SourceCitationSchema),
});
export type WikiClaimView = z.infer<typeof WikiClaimViewSchema>;

/** The source a page's claims and links rest on, resolved to its record for display. */
export const WikiPageSourceSchema = z.strictObject({
  id: IdentifierSchema,
  title: z.string(),
  kind: z.enum(['note', 'document', 'image', 'audio', 'video', 'session', 'answer', 'peer']),
  origin: z.enum(['course', 'external', 'student', 'peer', 'model']),
});
export type WikiPageSource = z.infer<typeof WikiPageSourceSchema>;

/** GET /api/wiki/pages/:id — one page through the permitted view, claims judged live. */
export const WikiPageViewSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
  title: z.string(),
  summary: z.string(),
  revision: RevisionSchema,
  updatedAt: TimestampSchema.nullable(),
  state: z.enum(['ok', 'out_of_band', 'malformed', 'newer_schema']),
  body: z.string(),
  claims: z.array(WikiClaimViewSchema),
  links: z.array(WikiLinkSchema),
  /** Sources the page rests on, resolved where a record still exists. */
  sources: z.array(WikiPageSourceSchema),
  /** Source ids named on the page that no longer resolve — shown, not hidden. */
  missingSourceIds: IdentifierListSchema,
  courseRefs: z.array(CourseConceptRefSchema),
});
export type WikiPageView = z.infer<typeof WikiPageViewSchema>;

/** One version a disagreement keeps — the claim text, whose it is, and what it rests on. */
export const WikiDisputeSideSchema = z.strictObject({
  /** Absent for a misconception carried from the earlier vault, which kept no claim ids. */
  claimId: IdentifierSchema.optional(),
  text: z.string(),
  origin: z.enum(['course', 'external', 'student', 'peer', 'model']),
  /** The sources this side's citations name, resolved where a record still exists. */
  sources: z.array(WikiPageSourceSchema),
  missingSourceIds: IdentifierListSchema,
  /** A course lesson the side points at, when it is the course's version. */
  lessonRef: z.string().optional(),
});
export type WikiDisputeSide = z.infer<typeof WikiDisputeSideSchema>;

/**
 * Two versions the brain keeps side by side. 'disputed_claims' is the merge policy's
 * dispute (same subject, different content — both claims stay, marked disputed);
 * 'misconception' is an unresolved one from the earlier vault: what the student said
 * against what the course says. Read-only: nothing here resolves anything.
 */
export const WikiDisputeSchema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(['disputed_claims', 'misconception']),
  pageId: IdentifierSchema,
  pageTitle: z.string(),
  pageKind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
  /** When the page last changed (or the misconception was flagged), if known. */
  at: z.string().nullable(),
  /** Earlier version first. One side only when the other claim is no longer on the page. */
  sides: z.array(WikiDisputeSideSchema).min(1).max(2),
  /** A Socratic opener the Guide can start from. */
  prompt: z.string(),
});
export type WikiDispute = z.infer<typeof WikiDisputeSchema>;

/** GET /api/wiki/disputes — every disagreement the vault currently keeps. */
export const WikiDisputesSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  disputes: z.array(WikiDisputeSchema),
});
export type WikiDisputes = z.infer<typeof WikiDisputesSchema>;

/**
 * POST /api/wiki/save — freeze one assistant answer as an 'answer' source and queue its
 * job. `saveKind` is a hint the keeper reads from the retained document; code never trusts
 * it to decide the page kind.
 */
export const SaveAnswerRequestSchema = z
  .strictObject({
    /** The conversation the answer came from. Exactly one of sessionId and askId is sent. */
    sessionId: IdentifierSchema.optional(),
    /** An "Ask your brain" answer the engine kept (POST /api/wiki/ask → done.result.askId). */
    askId: IdentifierSchema.optional(),
    /** Index into the session's turns; must point at an assistant message. Defaults to the latest one. */
    turnIndex: z.number().int().nonnegative().optional(),
    /**
     * The answer text as the student saw it. Sent alongside turnIndex because a failed turn
     * leaves a message in the UI without a stored turn, drifting the index: when both are
     * given, the engine finds the last stored assistant turn with this exact content rather
     * than trusting the position.
     */
    content: z.string().min(1).max(200_000).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    saveKind: z.enum(['synthesis', 'question']).optional(),
  })
  .strict()
  .refine((body) => (body.sessionId === undefined) !== (body.askId === undefined), { message: 'Send exactly one of sessionId or askId' });
export type SaveAnswerRequest = z.infer<typeof SaveAnswerRequestSchema>;

/** POST /api/wiki/ask — a question answered only from the student's own compiled pages. */
export const WikiAskRequestSchema = z.strictObject({
  question: z.string().trim().min(3).max(1000),
});
export type WikiAskRequest = z.infer<typeof WikiAskRequestSchema>;

const askPageRef = z.strictObject({
  pageId: IdentifierSchema,
  title: z.string(),
  kind: WikiPageEntrySchema.shape.kind,
  /**
   * A source summary, synthesis or question page is model-written: it can be named as
   * context but is never evidence — the same rule read_wiki_page applies to teachers.
   */
  generated: z.boolean(),
});
export const WikiAskPageSchema = askPageRef;
export type WikiAskPage = z.infer<typeof WikiAskPageSchema>;

/**
 * What "Ask your brain" answered. Every citation names a page that was in the model's
 * context — anything else was dropped and is listed. `evidence` is always 'student_wiki':
 * these are the student's own pages, never course evidence.
 */
export const WikiAskResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  /** Present when the answer was kept for "Save to wiki"; null when nothing was composed. */
  askId: IdentifierSchema.nullable(),
  question: z.string(),
  answer: z.string(),
  outcome: z.enum(['answered', 'empty_brain', 'no_hits', 'model_unavailable']),
  citations: z.array(askPageRef),
  /** Citations the model wrote that named no page it was shown — removed from the answer. */
  droppedCitations: z.array(z.string()),
  /** Pages in the vault the search ran over. */
  pagesSearched: z.number().int().nonnegative(),
  /** The top hits whose permitted views were read into the model's context. */
  pagesRead: z.array(askPageRef),
  searchMode: SearchModeSchema,
  /** The "served by" label, or null when no model was called. */
  model: z.string().nullable(),
  evidence: z.literal('student_wiki'),
});
export type WikiAskResult = z.infer<typeof WikiAskResultSchema>;

/** The SSE frames of POST /api/wiki/ask: progress first, then text, then one done (or error). */
export type WikiAskStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'pages'; pages: WikiAskPage[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; result: WikiAskResult }
  | { type: 'error'; message: string; code?: string };

/**
 * POST /api/brain/pages/:key/restore — writes the named historical revision as a NEW
 * revision on top of the page the caller read at `baseRevision`. History is append-only.
 */
export const RestorePageRequestSchema = z.strictObject({
  revision: z.string().min(1).max(160),
  baseRevision: z.string().min(1).max(160),
});
export type RestorePageRequest = z.infer<typeof RestorePageRequestSchema>;

export const LearningEventSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    id: IdentifierSchema,
    profile: ProfileIdentitySchema,
    pageId: IdentifierSchema,
    at: TimestampSchema,
    kind: z.enum(LEARNING_EVENT_KINDS),
    actor: z.enum(LEARNING_EVENT_ACTORS),
    evidence: z.array(EventEvidenceSchema).min(1),
    /** Short human context for the timeline — a link target, a claim fragment, a result id. */
    note: z.string().max(300).optional(),
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
