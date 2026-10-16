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
