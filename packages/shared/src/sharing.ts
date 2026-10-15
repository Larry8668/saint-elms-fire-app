import { z } from 'zod';
import {
  ContractVersionSchema,
  HttpUrlSchema,
  IdentifierSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
} from './contracts';

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

export const SharePayloadSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  markdown: z.string().min(1).max(10000),
  citations: z.array(ShareCitationSchema),
  attachments: z.array(SharedAttachmentSchema),
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
