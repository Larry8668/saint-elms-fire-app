import { z } from 'zod';
import {
  ContractVersionSchema,
  HttpUrlSchema,
  IdentifierSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
} from './contracts';

export const SHARE_CITATION_LIMIT = 20;
export const SHARE_ATTACHMENT_LIMIT = 8;

export const ShareCitationSchema = z.strictObject({
  title: z.string().min(1).max(300),
  url: HttpUrlSchema.optional(),
  locator: z.string().max(500).optional(),
});
export type ShareCitation = z.infer<typeof ShareCitationSchema>;

export const SharedAttachmentSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1).max(200),
  mediaType: z.enum(['text/plain', 'text/markdown', 'application/pdf', 'image/png', 'image/jpeg']),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
});
export type SharedAttachment = z.infer<typeof SharedAttachmentSchema>;

/**
 * The public allowlist for a published share: everything a peer may read lives in
 * these four fields. Sender, cohort and programme are derived from the verified
 * enrolment server-side, so the payload never carries authority claims.
 */
export const SharePayloadSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  markdown: z.string().min(1).max(10000),
  citations: z.array(ShareCitationSchema).max(SHARE_CITATION_LIMIT),
  attachments: z.array(SharedAttachmentSchema).max(SHARE_ATTACHMENT_LIMIT),
});
export type SharePayload = z.infer<typeof SharePayloadSchema>;

export const PublishShareRequestSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  programmeId: IdentifierSchema,
  idempotencyKey: IdentifierSchema,
  payload: SharePayloadSchema,
});
export type PublishShareRequest = z.infer<typeof PublishShareRequestSchema>;

export const PublishedShareSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: IdentifierSchema,
  revision: RevisionSchema,
  senderId: IdentifierSchema,
  senderName: z.string().min(1).max(80),
  programmeId: IdentifierSchema,
  cohortId: IdentifierSchema,
  createdAt: TimestampSchema,
  state: z.enum(['published', 'withdrawn']),
  payload: SharePayloadSchema,
});
export type PublishedShare = z.infer<typeof PublishedShareSchema>;

/** Keyset-paginated feed page; `nextCursor` is opaque and null on the last page. */
export const ShareFeedPageSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  items: z.array(PublishedShareSchema),
  nextCursor: z.string().max(512).nullable(),
});
export type ShareFeedPage = z.infer<typeof ShareFeedPageSchema>;

/** One recorded lifecycle action on a share — author withdrawal or staff removal. */
export const ShareModerationViewSchema = z.strictObject({
  action: z.enum(['withdraw', 'remove']),
  actorSubject: z.string().min(1).max(255),
  note: z.string().max(1000).nullable(),
  occurredAt: TimestampSchema,
});
export type ShareModerationView = z.infer<typeof ShareModerationViewSchema>;

export const AdminShareViewSchema = z.strictObject({
  ...PublishedShareSchema.shape,
  lastModeration: ShareModerationViewSchema.nullable(),
});
export type AdminShareView = z.infer<typeof AdminShareViewSchema>;

export const AdminSharePageSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  items: z.array(AdminShareViewSchema),
  nextCursor: z.string().max(512).nullable(),
});
export type AdminSharePage = z.infer<typeof AdminSharePageSchema>;

export const AdminShareDetailSchema = z.strictObject({
  ...AdminShareViewSchema.shape,
  events: z.array(ShareModerationViewSchema),
});
export type AdminShareDetail = z.infer<typeof AdminShareDetailSchema>;

export const RemoveShareRequestSchema = z.strictObject({
  note: z.string().trim().min(1).max(1000).optional(),
});
export type RemoveShareRequest = z.infer<typeof RemoveShareRequestSchema>;

/**
 * A feed item as the engine annotates it for the student's UI: the published share
 * plus local knowledge (authorship, whether this revision was already imported,
 * whether the student hid it). `import` and `ignored` never cross the network —
 * they live in the student's workspace.
 */
export const PeerFeedItemSchema = PublishedShareSchema.extend({
  /** True when the caller authored this share. */
  mine: z.boolean(),
  /** Set when this share+revision already has a peer source in the vault. */
  import: z.strictObject({ sourceId: IdentifierSchema, jobId: IdentifierSchema }).nullable(),
  /** Locally hidden by the student. */
  ignored: z.boolean(),
});
export type PeerFeedItem = z.infer<typeof PeerFeedItemSchema>;

/**
 * The engine's answer to the feed request. A non-`ok` state means the list is
 * honestly empty — never a fabricated feed: `offline` when the uni did not
 * answer, `auth_required` when there is no university session to try,
 * `unavailable` when the uni answered but refused (admission, mismatch).
 */
export const PeerFeedResponseSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  state: z.enum(['ok', 'offline', 'auth_required', 'unavailable']),
  /** Plain-language reason for a non-ok state; null when ok. */
  detail: z.string().nullable(),
  /** The cohort the feed belongs to, when the uni confirmed it. */
  cohortId: IdentifierSchema.nullable(),
  items: z.array(PeerFeedItemSchema),
  nextCursor: z.string().max(512).nullable(),
});
export type PeerFeedResponse = z.infer<typeof PeerFeedResponseSchema>;

/** One wiki page the student may publish — the picker lists these. */
export const ShareablePageSchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']),
  title: z.string().min(1),
  summary: z.string(),
  revision: RevisionSchema,
});
export type ShareablePage = z.infer<typeof ShareablePageSchema>;

export const ShareablePageListSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  items: z.array(ShareablePageSchema),
});
export type ShareablePageList = z.infer<typeof ShareablePageListSchema>;

/** What the engine needs to build a share draft for preview. */
export const ShareDraftRequestSchema = z.strictObject({
  pageId: IdentifierSchema,
  /**
   * Frozen source records whose *descriptors* ride along. Chosen one by one; the
   * original bytes never leave the device.
   */
  attachmentSourceIds: z.array(IdentifierSchema).max(SHARE_ATTACHMENT_LIMIT).optional(),
});
export type ShareDraftRequest = z.infer<typeof ShareDraftRequestSchema>;

/**
 * The result of the on-device safety screen that runs over a share's payload text
 * (title + body + attachment names — never sender, cohort or programme metadata).
 * Advisory only: `flagged` still imports and `unavailable` never blocks — the
 * student decides in review either way.
 */
export const ShareScreeningSchema = z.strictObject({
  status: z.enum(['clean', 'flagged', 'unavailable']),
  /** The named harm categories the screen reported; empty when none or unknown. */
  categories: z.array(z.string().max(80)).max(8),
  /** The model that answered, e.g. "shieldgemma:2b" — '' when nothing ran. */
  model: z.string().max(120),
});
export type ShareScreening = z.infer<typeof ShareScreeningSchema>;

/**
 * The draft the student reviews. `request` is the exact body the engine will
 * POST to the university on publish — the preview *is* the network payload.
 */
export const ShareDraftResponseSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  request: PublishShareRequestSchema,
  /** The disclosed recipient: the student's own cohort, as the engine knows it. */
  cohortId: IdentifierSchema.nullable(),
  /** What the deterministic builder left out, in words the UI can list. */
  excluded: z.array(z.string()),
  /** The on-device screen of what is about to publish — advisory, never a block. */
  screening: ShareScreeningSchema.optional(),
});
export type ShareDraftResponse = z.infer<typeof ShareDraftResponseSchema>;

export const PublishShareResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  share: PublishedShareSchema,
  /** True when the uni replayed an earlier publish (same idempotency key + payload). */
  replayed: z.boolean(),
});
export type PublishShareResult = z.infer<typeof PublishShareResultSchema>;

/** An own share as the student last saw it; `freshness` says whether the uni just confirmed it. */
export const OwnShareSchema = PublishedShareSchema.extend({
  freshness: z.enum(['live', 'stored']),
});
export type OwnShare = z.infer<typeof OwnShareSchema>;

export const OwnSharesResponseSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  /** False when the uni could not be reached — items then show their stored state. */
  reachable: z.boolean(),
  items: z.array(OwnShareSchema),
});
export type OwnSharesResponse = z.infer<typeof OwnSharesResponseSchema>;

/** What an import produced. The brain itself is untouched until the filed proposal is accepted. */
export const ShareImportResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  shareId: IdentifierSchema,
  sourceId: IdentifierSchema,
  jobId: IdentifierSchema,
  /** The filed proposal awaiting student review; null when the compile produced none. */
  proposalId: IdentifierSchema.nullable(),
  stage: z.enum(['queued', 'extracting', 'awaiting_source_review', 'compiling', 'awaiting_review', 'committed', 'no_changes', 'failed', 'cancelled']),
  /** True when this share+revision was already imported — nothing new was created. */
  reused: z.boolean(),
  /**
   * The on-device screen run over the payload before ingest. Absent on a `reused`
   * import — nothing new was fetched, so nothing new was screened.
   */
  screening: ShareScreeningSchema.optional(),
});
export type ShareImportResult = z.infer<typeof ShareImportResultSchema>;

/** The quarantined pre-admission relay listing; its authors are never re-attributed. */
export const LegacySharePageSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  quarantined: z.literal(true),
  items: z.array(
    z.strictObject({
      id: z.string(),
      cohortId: z.string(),
      fromStudent: z.string(),
      title: z.string(),
      markdown: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type LegacySharePage = z.infer<typeof LegacySharePageSchema>;
