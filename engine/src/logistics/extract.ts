import {
  LogisticsExtractionSchema,
  TimeZoneSchema,
  type ChatAttachment,
  type LogisticsDraft,
  type LogisticsExtraction,
  type LogisticsRecord,
  type LogisticsWrite,
} from '@sef/shared';
import { generateStructured } from '../agents/factory';
import { extractedTextLane } from '../agents/lanes';
import { errorFields, log } from '../config';
import type { ResolvedModel } from '../models/registry';
import type { LogisticsAccess } from './store';

export const LOGISTICS_READER_INSTRUCTIONS = `You read a photo of a university notice, timetable, deadline list or reminder and list the logistics records it shows.
Rules:
- Only what the image actually shows. If a date, deadline or time is not visible, leave dueAt null — never guess.
- dueAt: ISO date (YYYY-MM-DD) when only a day is shown, or ISO date-time when a time is shown. Set allDay true for bare dates.
- timeZone: an IANA time zone only when the image states one; otherwise null.
- kind: deadline | event | notice | timetable | reminder.
- details: one line — what the entry says, where, who it applies to.
- Never list a person's name, phone number, email or other personal details.
- If the image shows no deadlines, dates or schedule entries, return an empty records array.`;

export type ExtractionOutcome =
  | { ok: true; proposed: LogisticsRecord[] }
  | { ok: false; reason: 'privacy' | 'unavailable' | 'nothing_found'; message: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Code decides what a draft becomes: an unparsable date is kept as a quoted note and
 * dueAt is left empty rather than invented, and a zone that is not a real IANA name is
 * noted and dropped — the student fixes both on confirmation.
 */
export function sanitiseDraft(draft: LogisticsDraft): LogisticsWrite {
  let dueAt = draft.dueAt?.trim() || null;
  let allDay = draft.allDay;
  let details = draft.details.trim().slice(0, 2000);
  if (dueAt && DATE_ONLY.test(dueAt)) {
    allDay = true;
  } else if (dueAt && !Number.isNaN(Date.parse(dueAt))) {
    allDay = false;
  } else if (dueAt) {
    details = `${details}${details ? ' ' : ''}(the image shows “${dueAt.slice(0, 60)}” as the date)`.slice(0, 2000);
    dueAt = null;
  }
  const rawZone = draft.timeZone?.trim() || null;
  const zone = rawZone ? TimeZoneSchema.safeParse(rawZone) : null;
  const timeZone = zone?.success ? zone.data : null;
  if (rawZone && !timeZone) details = `${details}${details ? ' ' : ''}(the image names “${rawZone.slice(0, 64)}” as the zone)`.slice(0, 2000);
  return { title: draft.title.trim().slice(0, 200) || 'Untitled record', kind: draft.kind, dueAt, allDay, timeZone, details };
}

/**
 * One pass of the vision model over a notice or timetable photo, run through the same
 * privacy lane as any other image read-out before anything is filed. What survives is
 * written as `proposed` records — the student's confirmation is the only path to fact.
 */
export async function extractLogistics(
  image: ChatAttachment,
  resolved: ResolvedModel,
  store: LogisticsAccess,
  opts: { note?: string; read?: typeof generateStructured } = {},
): Promise<ExtractionOutcome> {
  const read = opts.read ?? generateStructured;
  let extraction: LogisticsExtraction;
  try {
    const { object } = await read({
      agentId: 'logistics-reader',
      instructions: LOGISTICS_READER_INSTRUCTIONS,
      resolved,
      prompt: 'List every deadline, event, notice or timetable entry visible in this image.',
      images: [image],
      schema: LogisticsExtractionSchema,
    });
    extraction = object;
  } catch (error) {
    log.warn('logistics_extract_unavailable', errorFields(error));
    return { ok: false, reason: 'unavailable', message: 'The vision model could not read that image just now — nothing was filed.' };
  }

  // What a model claims to see is untrusted input: the same lane check as a typed
  // message decides whether it may be filed at all.
  const combined = extraction.records.map((r) => `${r.title}\n${r.details}`).join('\n');
  if (extractedTextLane(combined) === 'privacy') {
    log.warn('logistics_extract_privacy_refusal', {});
    return { ok: false, reason: 'privacy', message: 'That image looks like it holds personal details that are not yours, so nothing was filed.' };
  }

  const drafts = extraction.records.map(sanitiseDraft);
  if (!drafts.length) return { ok: false, reason: 'nothing_found', message: 'No deadlines or schedule entries were readable in that image.' };

  const proposed = await store.propose(drafts, {
    kind: 'friend_extraction',
    extractedFrom: 'image',
    model: resolved.label,
    ...(opts.note ? { note: opts.note } : {}),
  });
  log.info('logistics_proposals_filed', { drafted: drafts.length, filed: proposed.length });
  return { ok: true, proposed };
}
