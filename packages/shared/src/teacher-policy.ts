import { z } from 'zod';
import { CONCEPT_STATUSES } from './brain';
import { ContractVersionSchema, IdentifierSchema, NonemptyIdentifiersSchema, RevisionSchema, TimestampSchema } from './contracts';
import { TeacherIdSchema, type TeacherId } from './teachers';

export const ExplorationAnchorSchema = z.strictObject({
  pageId: IdentifierSchema,
  pageRevision: RevisionSchema,
  courseConceptKey: IdentifierSchema,
  courseRefs: NonemptyIdentifiersSchema,
});
export type ExplorationAnchor = z.infer<typeof ExplorationAnchorSchema>;

/**
 * One page the Philosopher may anchor to, as the catalogue serves it: the anchor contract
 * plus the display facts the picker needs. `pageRevision` is the revision a claim on this
 * anchor must name — it goes stale the moment the page changes.
 */
export const AnchorCandidateSchema = z.strictObject({
  pageId: IdentifierSchema,
  pageRevision: RevisionSchema,
  courseConceptKey: IdentifierSchema,
  courseRefs: NonemptyIdentifiersSchema,
  title: z.string().min(1).max(300),
  summary: z.string().max(2000),
  /** Mastery at catalogue time — a shaky page anchors just as well as a solid one. */
  status: z.enum(CONCEPT_STATUSES),
  courseName: z.string().max(300),
  /** The released course's name for the concept — the topic-only web query derives from it. */
  conceptLabel: z.string().min(1).max(300),
  updatedAt: TimestampSchema.nullable(),
});
export type AnchorCandidate = z.infer<typeof AnchorCandidateSchema>;

/** GET /api/anchors — every committed, course-linked concept page of the signed-in student's wiki. */
export const AnchorCatalogSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  anchors: z.array(AnchorCandidateSchema),
});
export type AnchorCatalog = z.infer<typeof AnchorCatalogSchema>;

/**
 * GET /api/anchors/match — free text judged against the catalogue. `ambiguous` never picks:
 * the client must show the candidates and let the student choose.
 */
export const AnchorMatchResultSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  outcome: z.enum(['resolved', 'ambiguous', 'none']),
  anchors: z.array(AnchorCandidateSchema),
});
export type AnchorMatchResult = z.infer<typeof AnchorMatchResultSchema>;

/**
 * GET /api/anchors/:pageId/web-preview — what would leave the device if web search were
 * consented to this turn: a topic-only query derived in code, plus where it would go.
 */
export const WebPreviewSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  query: z.string().min(1).max(300),
  engine: z.literal('searxng'),
  host: z.string(),
  reachable: z.boolean(),
});
export type WebPreview = z.infer<typeof WebPreviewSchema>;

/**
 * What a teacher may reach, across the five surfaces a turn can touch. Declared, not inferred:
 * anything not named here is refused rather than quietly absent.
 */
export const CAPABILITY_IDS = [
  'context:support_notes',
  'context:released_lessons',
  'context:student_brain',
  'context:logistics',
  'context:wiki_index',
  'tool:search_lessons',
  'tool:read_lesson',
  'tool:brain_lookup',
  'tool:weakest_concepts',
  'tool:web_search',
  'tool:handoff',
  'tool:logistics',
  'tool:search_wiki',
  'tool:read_wiki_page',
  'lesson:support_pool',
  'lesson:academic_pool',
  'lesson:full_text',
  'claim:wiki_claims',
  'claim:learner_evidence',
  'attachment:image',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export type CapabilityNamespace = CapabilityId extends `${infer N}:${string}` ? N : never;

export const CAPABILITY_NAMESPACES = ['context', 'tool', 'lesson', 'claim', 'attachment'] as const;

export const TeacherPolicySchema = z.strictObject({
  teacher: TeacherIdSchema,
  knowledge: z.array(
    z.enum([
      'university_support',
      'confirmed_logistics',
      'released_courseware',
      'course_wiki_claims',
      'learner_evidence',
      'anchored_wiki',
      'consented_web',
    ]),
  ),
  anchor: z.enum(['none', 'personal_wiki_course_concept']),
  web: z.enum(['never', 'explicit_consent']),
  capabilities: z.array(z.enum(CAPABILITY_IDS)),
});
export type TeacherPolicy = z.infer<typeof TeacherPolicySchema>;

export const TEACHER_POLICIES = {
  friend: {
    teacher: 'friend',
    knowledge: ['university_support', 'confirmed_logistics'],
    anchor: 'none',
    web: 'never',
    capabilities: ['context:support_notes', 'context:logistics', 'tool:search_lessons', 'tool:handoff', 'tool:logistics', 'lesson:support_pool', 'lesson:full_text', 'attachment:image'],
  },
  guide: {
    teacher: 'guide',
    knowledge: ['released_courseware', 'course_wiki_claims', 'learner_evidence'],
    anchor: 'none',
    web: 'never',
    capabilities: [
      'context:released_lessons',
      'context:student_brain',
      'tool:search_lessons',
      'tool:read_lesson',
      'tool:brain_lookup',
      'tool:weakest_concepts',
      'tool:handoff',
      'tool:search_wiki',
      'tool:read_wiki_page',
      'context:wiki_index',
      'lesson:academic_pool',
      'lesson:full_text',
      'claim:wiki_claims',
      'claim:learner_evidence',
      'attachment:image',
    ],
  },
  philosopher: {
    teacher: 'philosopher',
    knowledge: ['anchored_wiki', 'released_courseware', 'consented_web'],
    anchor: 'personal_wiki_course_concept',
    web: 'explicit_consent',
    capabilities: ['context:released_lessons', 'context:wiki_index', 'tool:search_lessons', 'tool:web_search', 'tool:brain_lookup', 'tool:handoff', 'tool:search_wiki', 'tool:read_wiki_page', 'lesson:academic_pool', 'lesson:full_text', 'claim:wiki_claims'],
  },
} as const satisfies Record<TeacherId, TeacherPolicy>;

export class CapabilityDeniedError extends Error {
  constructor(
    readonly teacher: TeacherId,
    readonly capability: CapabilityId,
  ) {
    super(`${teacher} is not permitted ${capability}`);
    this.name = 'CapabilityDeniedError';
  }
}

export function teacherPolicy(teacher: TeacherId): TeacherPolicy {
  return TEACHER_POLICIES[teacher];
}

/** Deny by default: an undeclared capability is refused, never silently missing. */
export function can(teacher: TeacherId, capability: CapabilityId): boolean {
  return (TEACHER_POLICIES[teacher].capabilities as readonly CapabilityId[]).includes(capability);
}

export function assertCapability(teacher: TeacherId, capability: CapabilityId): void {
  if (!can(teacher, capability)) throw new CapabilityDeniedError(teacher, capability);
}

export function capabilitiesFor(teacher: TeacherId, namespace: CapabilityNamespace): CapabilityId[] {
  const prefix = `${namespace}:`;
  return TEACHER_POLICIES[teacher].capabilities.filter((c) => c.startsWith(prefix));
}

export const ChatMessageRequestSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    teacher: TeacherIdSchema,
    sessionId: IdentifierSchema.optional(),
    clientMessageId: IdentifierSchema,
    message: z.string().max(8000),
    attachments: z
      .array(
        z.strictObject({
          kind: z.literal('image'),
          mimeType: z.enum(['image/png', 'image/jpeg']),
          data: z.string().min(1).max(12000000),
          name: z.string().max(200).optional(),
        }),
      )
      .max(2)
      .optional(),
    anchorPageId: IdentifierSchema.optional(),
    /** The catalogue revision the client believes it anchored to — verified fresh, never trusted. */
    anchorRevision: RevisionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.message.trim() && !value.attachments?.length) {
      ctx.addIssue({ code: 'custom', path: ['message'], message: 'A message or image is required' });
    }
    if ((value.anchorPageId || value.anchorRevision) && value.teacher !== 'philosopher') {
      ctx.addIssue({
        code: 'custom',
        path: ['anchorPageId'],
        message: 'Only Philosopher requests select an exploration anchor',
      });
    }
    if (value.anchorRevision && !value.anchorPageId) {
      ctx.addIssue({ code: 'custom', path: ['anchorRevision'], message: 'An anchor revision needs the page it claims' });
    }
  });
export type ChatMessageRequest = z.infer<typeof ChatMessageRequestSchema>;

/** Why a turn was refused before any model ran. The list is closed: nothing else is a refusal. */
export const TURN_REJECTIONS = [
  'unknown_session',
  'session_owner_mismatch',
  'teacher_mismatch',
  'replayed_turn',
  'concurrent_turn',
  'session_closed',
  'capability_denied',
  'anchor_required',
] as const;
export type TurnRejection = (typeof TURN_REJECTIONS)[number];

/** A conversation the server issued. Clients may only reference one of these by id. */
export const ConversationSessionSchema = z.strictObject({
  sessionId: IdentifierSchema,
  teacher: TeacherIdSchema,
  profileId: IdentifierSchema,
  createdAt: TimestampSchema,
  turnCount: z.number().int().nonnegative(),
});
export type ConversationSession = z.infer<typeof ConversationSessionSchema>;

/**
 * One turn against a server-issued session. There is no `messages` field: the transcript is the
 * server's, so a client cannot invent history. `clientMessageId` makes a retried turn a replay.
 */
export const ConversationTurnSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    sessionId: IdentifierSchema,
    teacher: TeacherIdSchema,
    clientMessageId: IdentifierSchema,
    message: z.string().max(8000),
    attachments: z
      .array(
        z.strictObject({
          kind: z.literal('image'),
          mimeType: z.enum(['image/png', 'image/jpeg']),
          data: z.string().min(1).max(12000000),
          name: z.string().max(200).optional(),
          /** Untrusted client text describing the image. Read by the lane check, never trusted. */
          altText: z.string().max(500).optional(),
        }),
      )
      .max(2)
      .optional(),
    consent: z.strictObject({ web: z.boolean() }).optional(),
    /** The committed wiki page to explore from. Unverified until the anchor seam resolves it. */
    anchorPageId: IdentifierSchema.optional(),
    /** The catalogue revision the client anchored to — a mismatch is a stale anchor. */
    anchorRevision: RevisionSchema.optional(),
    /** Free text naming a page, resolved in code; an ambiguous match is refused, never guessed. */
    anchorQuery: z.string().min(1).max(300).optional(),
    /** A released syllabus concept: resolves to the student's own committed page for it, if one exists. */
    syllabusConceptKey: IdentifierSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.message.trim() && !value.attachments?.length) {
      ctx.addIssue({ code: 'custom', path: ['message'], message: 'A message or image is required' });
    }
    const selectors = [value.anchorPageId, value.anchorQuery, value.syllabusConceptKey].filter((v) => v !== undefined).length;
    if (selectors > 1) {
      ctx.addIssue({ code: 'custom', path: ['anchorPageId'], message: 'Pick one way to name the exploration anchor' });
    }
    if ((selectors > 0 || value.anchorRevision) && value.teacher !== 'philosopher') {
      ctx.addIssue({ code: 'custom', path: ['anchorPageId'], message: 'Only Philosopher turns select an exploration anchor' });
    }
    if (value.anchorRevision && !value.anchorPageId) {
      ctx.addIssue({ code: 'custom', path: ['anchorRevision'], message: 'An anchor revision needs the page it claims' });
    }
  });
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

/** An explicit hand-off moves a thread to another teacher; it never edits a session's teacher. */
export const ConversationHandoffSchema = z.strictObject({
  sessionId: IdentifierSchema,
  to: TeacherIdSchema,
  reason: z.string().min(1).max(300),
});
export type ConversationHandoff = z.infer<typeof ConversationHandoffSchema>;