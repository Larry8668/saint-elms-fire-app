import { z } from 'zod';
import { EDGE_TYPES, IdentifierSchema } from '@sef/shared';

/**
 * What the keeper model is asked to produce. Deliberately looser than the vault contracts:
 * the model drafts prose, claims and connections, and `normalize.ts` turns that into a
 * WikiProposal — resolving quotes to real citations, ids to real pages, and deciding what
 * is kept. Nothing here is trusted until that pass runs.
 */
export const KeeperDraftSchema = z.object({
  pages: z
    .array(
      z.object({
        /** Id of an existing page from the context to update; omit to create a page. */
        id: IdentifierSchema.optional(),
        title: z.string().min(1).max(300),
        kind: z.enum(['concept', 'source_summary', 'synthesis', 'question']).default('concept'),
        /** One line for the index — what this page holds now. */
        summary: z.string().min(1).max(2000),
        markdown: z.string().default(''),
        learner: z
          .object({
            inMyWords: z.string().optional(),
            stuck: z.string().optional(),
            connections: z.string().optional(),
          })
          .optional(),
        claims: z
          .array(
            z.object({
              text: z.string().min(1),
              kind: z.enum(['source_fact', 'student_belief', 'deduction', 'question']),
              /** The exact passage in a provided source this claim rests on. */
              quote: z.string().optional(),
            }),
          )
          .max(12)
          .default([]),
      }),
    )
    .max(6)
    .default([]),
  links: z
    .array(
      z.object({
        /** Page id, or the exact title of a page in scope or in this draft. */
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.string().describe(`One of: ${EDGE_TYPES.join(', ')}`),
        why: z.string().min(1),
        /** The exact student passage that voices this connection, when the student made it. */
        quote: z.string().optional(),
      }),
    )
    .max(10)
    .default([]),
});
export type KeeperDraft = z.infer<typeof KeeperDraftSchema>;

export const WIKI_KEEPER_INSTRUCTIONS = `
You keep one student's second brain: a markdown wiki that grows with what they study.
You are shown the vault's current pages, its index, and the new SOURCE MATERIAL.

Your job: draft page updates. Code — not you — decides what is actually kept, so cite
honestly and prefer fewer accurate entries over many vague ones. Empty arrays are fine;
proposing nothing is a valid answer.

Rules:
- pages: only pages genuinely affected by the material. To update an existing page, send
  its id from the PAGES IN SCOPE list; to create one, omit id and give a clear title.
- markdown: the full page body, rewritten to reflect what is now known. If the page exists,
  keep what is still true; never invent content the sources do not support.
- claims: things the material establishes. kind:
    source_fact    — the source states it; REQUIRES a verbatim quote from a source.
    student_belief — the student's own words state or imply it; REQUIRES a verbatim quote
                     of what they actually said or wrote.
    deduction      — your inference; mark it so it is never mistaken for evidence.
    question       — something still open.
  The quote must be copied EXACTLY from a provided source — the engine locates it
  character-for-character and drops the claim if it cannot.
- learner: for concept pages only, and only when a student-authored source in this batch
  actually shows the student's voice. inMyWords is the student's own phrasing — never
  textbook prose attributed to them.
- links: connections between pages. type must be one of the listed edge types. If the
  student themselves voiced the connection, give the quote of them saying it.
- Contradictions are information: if the new material conflicts with an existing claim,
  still record it — the merge policy keeps both versions, visibly.
`.trim();
