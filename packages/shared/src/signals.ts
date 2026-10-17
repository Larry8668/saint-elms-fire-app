import { z } from 'zod';
import { ContractVersionSchema, TimestampSchema } from './contracts';

/**
 * Signals: things the engine notices on its own — deadlines, releases, shares, vault state,
 * model health, connectivity. Every signal is a derived view recomputed from existing stores
 * by deterministic detectors: no model call, no new network traffic, no action taken.
 * The student sees them as attention items they can dismiss or snooze.
 */

export const SIGNAL_KINDS = [
  'deadline',
  'notice',
  'release_update',
  'share_incoming',
  'proposal_pending',
  'vault_question',
  'maintenance_finding',
  'model_unavailable',
  'connectivity',
] as const;
export const SignalKindSchema = z.enum(SIGNAL_KINDS);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalUrgencySchema = z.enum(['info', 'soon', 'urgent']);
export type SignalUrgency = z.infer<typeof SignalUrgencySchema>;

export const SignalSchema = z.strictObject({
  /** Idempotent dedupe key, `kind:entityId:bucket` — e.g. `deadline:log-123:48h`. */
  key: z.string().min(3).max(200),
  kind: SignalKindSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(500),
  /** Names the detector rule that raised it — the UI's "why am I seeing this". */
  why: z.string().min(1).max(200),
  urgency: SignalUrgencySchema,
  entityRefs: z.array(z.string().min(1).max(200)).max(20),
  /** Present on deadline signals so policy can tell a <24 h deadline from a 48 h one. */
  dueAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Signal = z.infer<typeof SignalSchema>;

export const AttentionStateSchema = z.enum(['new', 'seen', 'dismissed']);
export type AttentionState = z.infer<typeof AttentionStateSchema>;

export const AttentionItemSchema = SignalSchema.extend({
  state: AttentionStateSchema,
  snoozedUntil: TimestampSchema.optional(),
  /** Policy output: false during quiet hours (except urgent <24 h deadlines). Ledger entry exists either way. */
  highlight: z.boolean(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

/** Profile-scoped and private. Defaults are the quietest useful setting. */
export const ProactivitySettingsSchema = z.strictObject({
  /** Master switch for attention items. Off: the ledger keeps evaluating, nothing is shown. */
  nudges: z.boolean(),
  /** Reserved for drafted wording (PR-33); the only scheduled model call, default off. */
  draftedAdvice: z.boolean(),
  quietHours: z.strictObject({ enabled: z.boolean(), start: ClockSchema, end: ClockSchema }),
  kinds: z.record(SignalKindSchema, z.boolean()),
});
export type ProactivitySettings = z.infer<typeof ProactivitySettingsSchema>;

export function defaultProactivity(): ProactivitySettings {
  return {
    nudges: true,
    draftedAdvice: false,
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
    kinds: Object.fromEntries(SIGNAL_KINDS.map((kind) => [kind, true])) as Record<SignalKind, boolean>,
  };
}

/** GET /api/attention and POST /api/attention/evaluate. */
export const AttentionResponseSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  items: z.array(AttentionItemSchema),
  evaluatedAt: TimestampSchema.nullable(),
  /** True while quiet hours suppress highlighting. */
  quiet: z.boolean(),
  nudges: z.boolean(),
});
export type AttentionResponse = z.infer<typeof AttentionResponseSchema>;

export const MAX_SNOOZE_HOURS = 7 * 24;
export const SnoozeRequestSchema = z.strictObject({ hours: z.number().int().min(1).max(MAX_SNOOZE_HOURS) });
export const SeenRequestSchema = z.strictObject({ keys: z.array(z.string().min(3).max(200)).min(1).max(200) });
