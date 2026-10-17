import { z } from 'zod';
import { ContractVersionSchema, TimestampSchema } from './contracts';

/**
 * Local-only evaluation counters: did proactivity help, and did it stay honest? Events live in
 * the student's own profile, are never exported and are never sent anywhere.
 */

export const METRIC_EVENT_KINDS = [
  'nudge_shown',
  'nudge_clicked',
  'nudge_dismissed',
  'nudge_snoozed',
  'suggestion_shown',
  'suggestion_sent',
  'plan_proposed',
  'plan_approved',
  'plan_step_completed',
  'plan_completed',
  'plan_abandoned',
] as const;
export const MetricEventKindSchema = z.enum(METRIC_EVENT_KINDS);
export type MetricEventKind = z.infer<typeof MetricEventKindSchema>;

/** Only what the UI alone can observe. Dismissals, snoozes and plan events are recorded engine-side. */
export const CLIENT_METRIC_KINDS = ['nudge_shown', 'nudge_clicked', 'suggestion_shown', 'suggestion_sent'] as const;

/** A short machine tag: a signal kind, a teacher, a seed kind. Never free text. */
const TagSchema = z.string().regex(/^[a-z_]{1,40}$/);

export const MetricEventSchema = z.strictObject({
  kind: MetricEventKindSchema,
  at: TimestampSchema,
  /** The item the event is about: a signal key, suggestion id, plan id. */
  ref: z.string().min(1).max(200),
  tag: TagSchema.optional(),
});
export type MetricEvent = z.infer<typeof MetricEventSchema>;

export const MAX_CLIENT_EVENTS_PER_CALL = 50;

/** POST /api/metrics/events — the engine stamps the time. */
export const RecordMetricsRequestSchema = z.strictObject({
  events: z
    .array(z.strictObject({ kind: z.enum(CLIENT_METRIC_KINDS), ref: z.string().min(1).max(200), tag: TagSchema.optional() }))
    .min(1)
    .max(MAX_CLIENT_EVENTS_PER_CALL),
});
export type RecordMetricsRequest = z.infer<typeof RecordMetricsRequestSchema>;

/** A rate with its parts, so the UI can say "3 of 12" instead of a bare, overconfident percentage. */
export const RateSchema = z.strictObject({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  /** Null when there is nothing to divide by yet. */
  rate: z.number().min(0).max(1).nullable(),
});
export type Rate = z.infer<typeof RateSchema>;

/** A nudge dismissed within this long of first being shown counts as a false alert. */
export const FALSE_ALERT_WINDOW_MS = 5_000;

/** GET /api/metrics */
export const MetricsReportSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  generatedAt: TimestampSchema,
  /** Oldest retained event; older ones were rotated away. */
  since: TimestampSchema.nullable(),
  events: z.number().int().nonnegative(),
  /** Distinct suggestions sent ÷ distinct suggestions shown. */
  suggestionAcceptance: RateSchema,
  /** Distinct nudges dismissed within 5 s of first showing ÷ distinct nudges shown. */
  falseAlerts: RateSchema,
  /** Distinct nudges clicked ÷ distinct nudges shown. */
  nudgeEngagement: RateSchema,
  /** Plans completed ÷ plans approved. */
  planCompletion: RateSchema,
  planStepsCompleted: z.number().int().nonnegative(),
  /** Teacher turns refused by policy ÷ all teacher turns, from stored conversations. */
  refusals: RateSchema,
  /** Wiki proposals the student accepted ÷ proposals the student decided. */
  proposalAcceptance: RateSchema,
  /** Distinct nudges shown, by signal kind. */
  signalVolumes: z.record(z.string(), z.number().int().nonnegative()),
});
export type MetricsReport = z.infer<typeof MetricsReportSchema>;
