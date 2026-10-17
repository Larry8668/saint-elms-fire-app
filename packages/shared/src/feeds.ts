import { z } from 'zod';
import { ContractVersionSchema, TimestampSchema } from './contracts';

/**
 * Subject feeds: consented RSS/Atom awareness. Only an item's title, summary and link are
 * ever stored — article bodies are never fetched — and nothing here is model input unless
 * the student clicks a suggestion that names it.
 */

export const MAX_FEEDS = 20;
export const MAX_ITEMS_PER_FEED = 20;
export const MAX_UNI_FEEDS_PER_COURSE = 10;

/** HTTPS only: a feed's host becomes an egress allowance, so it must be unambiguous. */
export const FeedUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an https:// feed address');

/** How a university names a feed inside signed course metadata. */
export const SubjectFeedRefSchema = z.strictObject({
  url: FeedUrlSchema,
  title: z.string().trim().min(1).max(120),
});
export type SubjectFeedRef = z.infer<typeof SubjectFeedRefSchema>;

export const FeedOriginSchema = z.enum(['uni', 'student']);

export const FeedSchema = z.strictObject({
  id: z.string().min(1).max(80),
  url: FeedUrlSchema,
  title: z.string().min(1).max(120),
  origin: FeedOriginSchema,
  /** Set for uni feeds: the course whose signed metadata lists it. */
  courseId: z.string().max(120).optional(),
  /** Null until the student allows fetching; no request is made before this is set. */
  consentedAt: TimestampSchema.nullable(),
  enabled: z.boolean(),
  addedAt: TimestampSchema,
  lastFetchedAt: TimestampSchema.optional(),
  lastSuccessAt: TimestampSchema.optional(),
  /** Consecutive failed polls; a long run surfaces as a quiet "feed not responding" item. */
  failures: z.number().int().nonnegative(),
  lastError: z.string().max(200).optional(),
  /** Conditional-GET validators from the last full response. */
  etag: z.string().max(200).optional(),
  lastModified: z.string().max(100).optional(),
});
export type Feed = z.infer<typeof FeedSchema>;

export const FeedItemSchema = z.strictObject({
  id: z.string().min(1).max(80),
  feedId: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  summary: z.string().max(400),
  link: z.string().max(1000),
  publishedAt: TimestampSchema.nullable(),
  fetchedAt: TimestampSchema,
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

/** GET /api/feeds */
export const FeedsResponseSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  feeds: z.array(FeedSchema),
  items: z.array(FeedItemSchema),
});
export type FeedsResponse = z.infer<typeof FeedsResponseSchema>;

/** POST /api/feeds — adds a student feed, disabled until consent. */
export const AddFeedRequestSchema = z.strictObject({
  url: FeedUrlSchema,
  title: z.string().trim().min(1).max(120).optional(),
});

/** POST /api/feeds/:id/consent */
export const FeedConsentRequestSchema = z.strictObject({ enabled: z.boolean() });
