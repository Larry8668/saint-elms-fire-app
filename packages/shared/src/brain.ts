import { z } from 'zod';

export const EDGE_TYPES = ['prerequisite', 'builds_upon', 'related_to', 'contrasts_with', 'part_of'] as const;
export const EdgeTypeSchema = z.enum(EDGE_TYPES);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

/** Where a link came from. Drives how it is drawn and how much it is trusted. */
export const EDGE_ORIGINS = ['course', 'student', 'peer', 'suggested'] as const;
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number];

export const CONCEPT_STATUSES = ['unseen', 'met', 'shaky', 'solid'] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export const EvidenceSchema = z.object({
  kind: z.enum(['session', 'quiz', 'capture', 'lesson', 'share']),
  ref: z.string(),
  at: z.string(),
  score: z.number().optional(),
  outOf: z.number().optional(),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const MisconceptionSchema = z.object({
  claim: z.string(),
  course: z.string(),
  lessonRef: z.string().optional(),
  flagged: z.string(),
  resolved: z.boolean().default(false),
});
export type Misconception = z.infer<typeof MisconceptionSchema>;

export const PageLinkSchema = z.object({
  to: z.string(),
  type: EdgeTypeSchema,
  origin: z.enum(EDGE_ORIGINS),
  why: z.string().optional(),
});
export type PageLink = z.infer<typeof PageLinkSchema>;

export const PAGE_SECTIONS = ['in_my_words', 'where_i_got_stuck', 'connections'] as const;
export type PageSection = (typeof PAGE_SECTIONS)[number];

export const SECTION_TITLES: Record<PageSection, string> = {
  in_my_words: 'In my words',
  where_i_got_stuck: 'Where I got stuck',
  connections: 'Connections I made',
};

export interface ConceptPage {
  key: string;
  concept: string;
  courseRefs: string[];
  status: ConceptStatus;
  evidence: Evidence[];
  misconceptions: Misconception[];
  links: PageLink[];
  updated: string;
  sections: Record<PageSection, string>;
}

/**
 * What the model is asked to return after a session or capture.
 * Flat and capped: small models are far more reliable on shallow, bounded schemas,
 * and passing the allowed concepts as an enum makes invalid names impossible to emit.
 */
export function brainProposalSchema(allowedConcepts: [string, ...string[]] | null = null) {
  const concept = allowedConcepts ? z.enum(allowedConcepts) : z.string();
  return z.object({
    pages: z
      .array(
        z.object({
          concept,
          in_my_words: z.string().describe("One to three sentences in the student's own voice, reflecting what they showed they understand"),
          where_i_got_stuck: z.string().describe('What confused the student, or empty string'),
        }),
      )
      .max(5)
      .default([]),
    misconceptions: z.array(z.object({ concept, student_claim: z.string(), course_says: z.string() })).max(3).default([]),
    resolved: z
      .array(z.object({ concept, claim: z.string().describe('The earlier misconception the student has now corrected') }))
      .max(3)
      .default([]),
    edges: z
      .array(
        z.object({
          from: concept,
          to: concept,
          type: z.string().describe(`One of: ${EDGE_TYPES.join(', ')}`),
          why: z.string(),
          student_made: z.boolean().describe('True only if the student themselves stated this connection'),
        }),
      )
      .max(4)
      .default([]),
  });
}

const EDGE_SYNONYMS: Record<string, EdgeType> = {
  prerequisite: 'prerequisite',
  requires: 'prerequisite',
  needs: 'prerequisite',
  builds_upon: 'builds_upon',
  builds_on: 'builds_upon',
  extends: 'builds_upon',
  related_to: 'related_to',
  related: 'related_to',
  similar: 'related_to',
  contrasts_with: 'contrasts_with',
  contrasts: 'contrasts_with',
  opposite: 'contrasts_with',
  part_of: 'part_of',
  component: 'part_of',
};

/** Maps a model's free-text edge type onto the allowed set, or null. */
export function normalizeEdgeType(raw: string): EdgeType | null {
  const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return EDGE_SYNONYMS[cleaned] ?? null;
}

export const BrainProposalSchema = brainProposalSchema();
export type BrainProposal = z.infer<typeof BrainProposalSchema>;

export type BrainEditOp =
  | { op: 'create_page'; key: string; concept: string; courseRefs: string[] }
  | { op: 'update_section'; key: string; section: PageSection; mode: 'append' | 'replace'; text: string }
  | { op: 'add_link'; from: string; to: string; type: EdgeType; origin: EdgeOrigin; why: string }
  | { op: 'add_evidence'; key: string; evidence: Evidence }
  | { op: 'flag_misconception'; key: string; claim: string; course: string; lessonRef?: string }
  | { op: 'resolve_misconception'; key: string; claim: string };

export interface RejectedOp {
  op: BrainEditOp | Record<string, unknown>;
  reason: string;
}

export interface BrainDiffEntry {
  key: string;
  concept: string;
  change: 'created' | 'updated';
  before?: string;
  after: string;
  statusBefore: ConceptStatus;
  statusAfter: ConceptStatus;
}

export interface IngestResult {
  trigger: { kind: Evidence['kind']; ref: string };
  applied: BrainEditOp[];
  rejected: RejectedOp[];
  diff: BrainDiffEntry[];
  model: string;
  durationMs: number;
}

export interface LintFinding {
  kind: 'misconception' | 'shaky_prerequisite' | 'orphan' | 'oversized';
  key: string;
  concept: string;
  message: string;
  /** A Socratic opener the Guide can use for this finding. */
  prompt: string;
}

export interface BrainLogEntry {
  at: string;
  kind: string;
  title: string;
  detail?: string;
}
