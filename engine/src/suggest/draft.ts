import { z } from 'zod';
import type { TeacherId } from '@sef/shared';
import { generateStructured } from '../agents/factory';
import { resolveModel } from '../models/registry';
import type { StoredSettings } from '../settings/store';
import type { Seed } from './seeds';

export const MAX_DRAFT_CHARS = 240;

export const DraftOutputSchema = z.object({ questions: z.array(z.string()) });

/** Rephrases template questions in a teacher's voice; supplied by the workspace (model-backed). */
export type Rephrase = (teacher: TeacherId, questions: string[]) => Promise<string[]>;

const VOICES: Record<TeacherId, string> = {
  friend: 'a warm, practical friend who helps with university logistics',
  guide: 'a patient course guide who teaches the released material',
  philosopher: 'a curious philosopher who explores ideas and connections',
};

export function draftInstructions(teacher: TeacherId): string {
  return [
    `Rewrite each question as the student would ask ${VOICES[teacher]}.`,
    'Keep every quoted title and every named concept exactly as written.',
    'Do not add topics, facts, dates or names that are not already in the question.',
    `Keep each question under ${MAX_DRAFT_CHARS} characters. Return the same number of questions, in order, as JSON {"questions": [...]}.`,
  ].join(' ');
}

/** Rephrasing prompt: the questions themselves are the only input — no vault content. */
export function draftPrompt(questions: string[]): string {
  return questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

/** The model-backed rephraser on the `brain` role. Callers treat any throw as "use templates". */
export function modelRephrase(settings: () => Promise<StoredSettings>): Rephrase {
  return async (teacher, questions) => {
    const resolved = resolveModel(await settings(), 'brain');
    const { object } = await generateStructured({
      agentId: 'suggestion-drafter',
      instructions: draftInstructions(teacher),
      resolved,
      prompt: draftPrompt(questions),
      schema: DraftOutputSchema,
    });
    return object.questions;
  };
}

const names = (values: Iterable<string>) => [...values].filter((v) => v.length >= 3).map((v) => v.toLowerCase());

/**
 * The seed-entity check: a drafted question must keep every entity its seed names and
 * must not mention any *other* known entity. Anything else falls back to the template.
 */
export function acceptDraft(draft: string | undefined, seed: Seed, universe: ReadonlySet<string>): draft is string {
  if (typeof draft !== 'string') return false;
  const text = draft.trim();
  if (!text || text.length > MAX_DRAFT_CHARS) return false;
  const lower = text.toLowerCase();
  const own = names(Object.values(seed.slots));
  if (!own.every((name) => lower.includes(name))) return false;
  const foreign = names(universe).filter((name) => !own.some((mine) => mine.includes(name) || name.includes(mine)));
  return !foreign.some((name) => lower.includes(name));
}
