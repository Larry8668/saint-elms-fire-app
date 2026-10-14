import { z } from 'zod';
import { ContractVersionSchema, IdentifierSchema, NonemptyIdentifiersSchema, RevisionSchema } from './contracts';
import { TEACHER_IDS } from './teachers';

export const ExplorationAnchorSchema = z.strictObject({
  pageId: IdentifierSchema,
  pageRevision: RevisionSchema,
  courseConceptKey: IdentifierSchema,
  courseRefs: NonemptyIdentifiersSchema,
});
export type ExplorationAnchor = z.infer<typeof ExplorationAnchorSchema>;

export const TeacherPolicySchema = z.strictObject({
  teacher: z.enum(TEACHER_IDS),
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
});
export type TeacherPolicy = z.infer<typeof TeacherPolicySchema>;

export const TEACHER_POLICIES = {
  friend: { teacher: 'friend', knowledge: ['university_support', 'confirmed_logistics'], anchor: 'none', web: 'never' },
  guide: {
    teacher: 'guide',
    knowledge: ['released_courseware', 'course_wiki_claims', 'learner_evidence'],
    anchor: 'none',
    web: 'never',
  },
  philosopher: {
    teacher: 'philosopher',
    knowledge: ['anchored_wiki', 'released_courseware', 'consented_web'],
    anchor: 'personal_wiki_course_concept',
    web: 'explicit_consent',
  },
} as const;

export const ChatMessageRequestSchema = z
  .strictObject({
    schemaVersion: ContractVersionSchema,
    teacher: z.enum(TEACHER_IDS),
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
  })
  .superRefine((value, ctx) => {
    if (!value.message.trim() && !value.attachments?.length) {
      ctx.addIssue({ code: 'custom', path: ['message'], message: 'A message or image is required' });
    }
    if (value.anchorPageId && value.teacher !== 'philosopher') {
      ctx.addIssue({
        code: 'custom',
        path: ['anchorPageId'],
        message: 'Only Philosopher requests select an exploration anchor',
      });
    }
  });
export type ChatMessageRequest = z.infer<typeof ChatMessageRequestSchema>;
