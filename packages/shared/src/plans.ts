import { z } from 'zod';
import { ContractVersionSchema, TimestampSchema } from './contracts';

/**
 * Study plans: a stated goal decomposed into a bounded, inspectable checklist. A model may
 * *propose* steps; code checks every reference resolves, and only code ever writes a step's
 * state — completion is observed from evidence, never claimed. The student runs every step.
 */

export const MAX_PLAN_STEPS = 8;
export const MAX_ACTIVE_PLANS = 3;
export const MAX_PROPOSED_PLANS = 5;

export const PLAN_STEP_KINDS = ['review_page', 'read_lesson', 'answer_question', 'quiz', 'resolve_signal'] as const;
export const PlanStepKindSchema = z.enum(PLAN_STEP_KINDS);
export type PlanStepKind = z.infer<typeof PlanStepKindSchema>;

/** `page:<id>`, `lesson:<id>` or `signal:<key>`. */
export const EntityRefSchema = z.string().regex(/^(page|lesson|signal):[^\s]{1,200}$/);

export const PlanStepSchema = z.strictObject({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(160),
  detail: z.string().max(400),
  kind: PlanStepKindSchema,
  entityRefs: z.array(EntityRefSchema).min(1).max(5),
  /** The primary entity's title as resolved by code — what chips and deep links show. */
  subject: z.string().min(1).max(200),
  state: z.enum(['pending', 'done', 'stale']),
  doneAt: TimestampSchema.optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanStatusSchema = z.enum(['proposed', 'active', 'completed', 'abandoned']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const StudyPlanSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  id: z.string().min(1).max(40),
  goal: z.string().min(1).max(300),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deadlineAt: TimestampSchema.nullable(),
  status: PlanStatusSchema,
  approvedAt: TimestampSchema.optional(),
  steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS),
  /** Disclosures: steps dropped as unresolvable, truncation, staleness. */
  notes: z.array(z.string().max(300)).max(20),
  /** Set on a proposed revision of an active plan; approving it retires the original. */
  revisionOf: z.string().max(40).optional(),
  /** Installed course versions at approval, so a new release can mark lesson steps stale. */
  basis: z.record(z.string(), z.string()).optional(),
});
export type StudyPlan = z.infer<typeof StudyPlanSchema>;

/** POST /api/plans */
export const CreatePlanRequestSchema = z.strictObject({
  goal: z.string().trim().min(3).max(300),
  deadlineAt: TimestampSchema.optional(),
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequestSchema>;

/** GET /api/plans */
export const PlansResponseSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  plans: z.array(StudyPlanSchema),
});
export type PlansResponse = z.infer<typeof PlansResponseSchema>;

/**
 * What the planner model may return. No `state`, `id` or `doneAt`: unknown keys are
 * stripped, so a model cannot pre-complete a step however it phrases its output.
 */
export const PlannerDraftSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().optional(),
        kind: z.string(),
        entityRefs: z.array(z.string()),
      }),
    )
    .max(20),
  /** Set, with no steps, when the goal is not something a study plan can serve. */
  declined: z.string().optional(),
});
export type PlannerDraft = z.infer<typeof PlannerDraftSchema>;
