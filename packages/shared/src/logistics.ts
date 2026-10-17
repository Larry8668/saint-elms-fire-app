import { z } from 'zod';
import { ContractVersionSchema, IdentifierSchema, TimestampSchema } from './contracts';

/**
 * Personal logistics: the student's own deadlines, notices, timetable entries and
 * reminders. Private to the profile's workspace, readable by the Friend once the
 * student has confirmed them, and never publishable.
 *
 * The lifecycle mirrors the rest of the app: a model may *propose* a record (from a
 * notice photo), code files it as `proposed`, and only the student's own confirmation
 * moves it to `confirmed` — the only state the Friend may assert from. `dismissed`
 * keeps a rejected proposal on record instead of deleting the evidence of it.
 */

export const LOGISTICS_KINDS = ['deadline', 'event', 'notice', 'timetable', 'reminder'] as const;
export const LogisticsKindSchema = z.enum(LOGISTICS_KINDS);
export type LogisticsKind = z.infer<typeof LogisticsKindSchema>;

export const LOGISTICS_STATES = ['proposed', 'confirmed', 'dismissed'] as const;
export const LogisticsStateSchema = z.enum(LOGISTICS_STATES);
export type LogisticsState = z.infer<typeof LogisticsStateSchema>;

/** An IANA time zone name, checked against the runtime's own tz database. */
export const TimeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Not a recognised IANA time zone');

/**
 * A due date as the student knows it: a bare `YYYY-MM-DD` calendar date (an all-day
 * deadline) or an ISO date-time instant. Null means honestly "no date recorded".
 */
export const LogisticsDueSchema = z
  .string()
  .min(4)
  .max(40)
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)), 'Due must be a date (YYYY-MM-DD) or an ISO date-time');

export const LogisticsProvenanceSchema = z.strictObject({
  /** 'manual' — the student typed it. 'friend_extraction' — a model read it out of an image. */
  kind: z.enum(['manual', 'friend_extraction']),
  /** Where it came from, in the student's words or the flow's ("photo of the exam notice"). */
  note: z.string().max(300).optional(),
  extractedFrom: z.enum(['image']).optional(),
  /** Model label that produced an extraction, e.g. "gemma4:e4b · Ollama (on this device)". */
  model: z.string().max(160).optional(),
});
export type LogisticsProvenance = z.infer<typeof LogisticsProvenanceSchema>;

export const LogisticsRecordSchema = z.strictObject({
  id: IdentifierSchema,
  title: z.string().trim().min(1).max(200),
  kind: LogisticsKindSchema,
  state: LogisticsStateSchema,
  /** Calendar date (`allDay`) or ISO instant. Null when no usable date exists — never invented. */
  dueAt: LogisticsDueSchema.nullable(),
  /** True when dueAt is a bare calendar date with no meaningful clock time. */
  allDay: z.boolean(),
  /** The zone the due time is to be read in. Null is displayed as such, not guessed. */
  timeZone: TimeZoneSchema.nullable(),
  details: z.string().max(2000),
  provenance: LogisticsProvenanceSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type LogisticsRecord = z.infer<typeof LogisticsRecordSchema>;

/** The fields a student (or a sanitised extraction draft) may set — never id, state or provenance. */
export const LogisticsWriteSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  kind: LogisticsKindSchema,
  dueAt: LogisticsDueSchema.nullable(),
  allDay: z.boolean().default(false),
  timeZone: TimeZoneSchema.nullable(),
  details: z.string().max(2000).default(''),
});
export type LogisticsWrite = z.infer<typeof LogisticsWriteSchema>;
export type LogisticsWriteInput = z.input<typeof LogisticsWriteSchema>;

/** What the extraction model is asked to produce — flat, capped, no record lifecycle. */
export const LogisticsDraftSchema = z.strictObject({
  title: z.string().min(1).max(200),
  kind: LogisticsKindSchema,
  /** ISO date or date-time exactly as the image shows it; null when none is visible. */
  dueAt: z.string().max(60).nullable(),
  allDay: z.boolean().default(false),
  /** IANA zone only when the image names one; otherwise null. */
  timeZone: z.string().max(64).nullable(),
  details: z.string().max(600).default(''),
});
export type LogisticsDraft = z.infer<typeof LogisticsDraftSchema>;

export const LOGISTICS_EXTRACT_MAX = 12;
export const LogisticsExtractionSchema = z.strictObject({ records: z.array(LogisticsDraftSchema).max(LOGISTICS_EXTRACT_MAX) });
export type LogisticsExtraction = z.infer<typeof LogisticsExtractionSchema>;

export const LogisticsListSchema = z.strictObject({ schemaVersion: ContractVersionSchema, items: z.array(LogisticsRecordSchema) });
export type LogisticsList = z.infer<typeof LogisticsListSchema>;

export const LogisticsRecordResultSchema = z.strictObject({ schemaVersion: ContractVersionSchema, record: LogisticsRecordSchema });
export type LogisticsRecordResult = z.infer<typeof LogisticsRecordResultSchema>;

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A naive date-time is a wall clock, not an instant: its fields are rendered as written. */
function wallClock(dueAt: string): string | null {
  const m = dueAt.match(NAIVE_DATETIME);
  if (!m) return null;
  const shown = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))));
  return shown;
}

/**
 * Renders a record's due moment the way it was recorded, for prompts and UI alike:
 * wall-clock times show their recorded zone and ISO instants are converted into it;
 * a missing zone or date is said, never guessed.
 */
export function formatDue(record: Pick<LogisticsRecord, 'dueAt' | 'allDay' | 'timeZone'>): string {
  if (!record.dueAt) return 'no date recorded';
  if (record.allDay || DATE_ONLY.test(record.dueAt)) return `due ${record.dueAt}${record.timeZone ? ` (${record.timeZone})` : ''}`;
  const naive = wallClock(record.dueAt);
  if (naive) return `due ${naive}${record.timeZone ? ` (${record.timeZone})` : ' — time zone not recorded'}`;
  if (record.timeZone) {
    try {
      const shown = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: record.timeZone }).format(new Date(record.dueAt));
      return `due ${shown} (${record.timeZone})`;
    } catch {
      // fall through to the raw rendering
    }
  }
  return `due ${record.dueAt}${record.timeZone ? '' : ' — time zone not recorded'}`;
}

/** How far a zone's wall clock sits from UTC at a given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second')) - utcMs;
}

/**
 * The moment a record falls due, in epoch ms. A bare date is due at the end of that day and
 * a naive wall clock is read in the record's zone (host-local when none was recorded).
 * Null when no date exists or the zone is unusable — never a guessed instant.
 */
export function dueInstant(record: Pick<LogisticsRecord, 'dueAt' | 'allDay' | 'timeZone'>): number | null {
  if (!record.dueAt) return null;
  const wall = DATE_ONLY.test(record.dueAt) || record.allDay ? `${record.dueAt.slice(0, 10)}T23:59:59` : record.dueAt;
  const m = wall.match(NAIVE_DATETIME);
  if (!m) {
    const instant = Date.parse(wall);
    return Number.isNaN(instant) ? null : instant;
  }
  if (!record.timeZone) return Date.parse(wall);
  try {
    const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
    // The offset must be the one in force at the target instant, not at the naive guess,
    // or a wall time near a DST change lands an hour out — so resolve it twice.
    const first = asUtc - zoneOffsetMs(asUtc, record.timeZone);
    return asUtc - zoneOffsetMs(first, record.timeZone);
  } catch {
    return null;
  }
}

/** Nearest deadline first; records with no date sort last, then by recency. */
export function compareLogistics(a: LogisticsRecord, b: LogisticsRecord): number {
  const stamp = (r: LogisticsRecord) => (r.dueAt ? Date.parse(r.allDay ? `${r.dueAt}T00:00:00` : r.dueAt) : Number.POSITIVE_INFINITY);
  return stamp(a) - stamp(b) || b.updatedAt.localeCompare(a.updatedAt);
}
