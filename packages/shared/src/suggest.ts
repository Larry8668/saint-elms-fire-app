import { z } from 'zod';
import { ContractVersionSchema, TimestampSchema } from './contracts';
import { TeacherIdSchema } from './teachers';

/**
 * Suggested questions: a small, ready-to-click bank per teacher built from the student's
 * own vault, calendar and signals. Code chooses *what* to suggest; a model may only
 * rephrase it (opt-in). Clicking sends the text as an ordinary student message.
 */
export const SuggestedQuestionSchema = z.strictObject({
  id: z.string().min(1).max(80),
  teacher: TeacherIdSchema,
  text: z.string().min(1).max(240),
  /** "Because …" provenance shown on hover. */
  why: z.string().min(1).max(200),
  /** The signal keys and page/lesson/logistics ids that motivated it. */
  seedRefs: z.array(z.string().min(1).max(200)).max(10),
  generatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type SuggestedQuestion = z.infer<typeof SuggestedQuestionSchema>;

export const SuggestionModeSchema = z.enum(['templates', 'drafted', 'hybrid']);
export type SuggestionMode = z.infer<typeof SuggestionModeSchema>;

export const MAX_SUGGESTIONS = 5;

/** GET /api/teachers/:teacher/suggestions */
export const SuggestionsResponseSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  teacher: TeacherIdSchema,
  questions: z.array(SuggestedQuestionSchema).max(MAX_SUGGESTIONS),
  generatedAt: TimestampSchema,
  /** Honest wording mode: templates only, all model-rephrased, or a mix. */
  mode: SuggestionModeSchema,
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;
