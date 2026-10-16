import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { can, type CapabilityId, conceptKey, TEACHER_IDS, teacherPolicy, type TeacherId, type Lesson } from '@sef/shared';
import { z } from 'zod';
import type { BrainService } from '../brain/service';
import { claimsFor, evidenceIndexFrom, renderClaims, type ClaimReader } from '../brain/claim-evidence';
import type { ContentStore } from '../content/store';
import { searchLessons } from '../content/search';
import { webSearch } from '../web/searxng';
import type { TurnContext } from './context';

export interface ToolDeps {
  content: ContentStore;
  brain: BrainService;
  searxngUrl: string;
  /** The student's wiki, so claim-level evidence filtering has something to judge against. */
  claims?: ClaimReader;
  /** Per-turn consent. Without it the Philosopher's web tool refuses rather than reaching out. */
  webConsented?: boolean;
}

/**
 * The pool a teacher may look in. Declared, not inferred: a teacher without a pool capability
 * searches nothing, rather than quietly seeing everything that is installed.
 */
async function lessonPool(teacher: TeacherId, content: ContentStore): Promise<Lesson[]> {
  if (can(teacher, 'lesson:support_pool')) return content.supportLessons();
  if (can(teacher, 'lesson:academic_pool')) return content.academicLessons();
  return [];
}

const poolKind = (teacher: TeacherId) => (can(teacher, 'lesson:support_pool') && !can(teacher, 'lesson:academic_pool') ? 'support' : 'lesson');

/**
 * Tools are built per turn so every call is recorded on the TurnContext — that is
 * what powers the verification panel ("what did the teacher actually look at?").
 *
 * Every tool is registered for every teacher, so a refusal is visible in the trace rather than
 * a capability that silently does not exist. Each one asks its teacher's policy first.
 */
export function buildTools(teacher: TeacherId, deps: ToolDeps, ctx: TurnContext): ToolsInput {
  /** Refuses, loudly and on the record, when the teacher's policy does not grant this capability. */
  const refuse = (capability: CapabilityId): { refused: true; capability: CapabilityId; error: string } => {
    ctx.recordTool(capability.split(':')[1]!, 'refused — not in this teacher’s policy');
    ctx.recordRefusal(capability);
    return { refused: true, capability, error: `${teacher} is not permitted ${capability}` };
  };

  const searchLessonsTool = createTool({
    id: 'search_lessons',
    description: "Search the student's released lessons. Returns titles, ids and matching excerpts.",
    inputSchema: z.object({ query: z.string().describe('What to look for') }),
    execute: async ({ query }) => {
      const capability: CapabilityId = can(teacher, 'lesson:support_pool') ? 'lesson:support_pool' : 'lesson:academic_pool';
      if (!can(teacher, capability)) return refuse(capability);
      const hits = searchLessons(await lessonPool(teacher, deps.content), query, 3);
      ctx.recordTool('search_lessons', `"${query}" → ${hits.length} lesson${hits.length === 1 ? '' : 's'}`);
      for (const h of hits) ctx.addSource({ kind: poolKind(teacher), id: h.lesson.id, title: h.lesson.title }, `${h.lesson.title}\n${h.excerpt}`);
      return hits.map((h) => ({ lessonId: h.lesson.id, title: h.lesson.title, course: h.lesson.courseName, excerpt: h.excerpt }));
    },
  });

  const readLessonTool = createTool({
    id: 'read_lesson',
    description: 'Read the full text of one released lesson by id.',
    inputSchema: z.object({ lessonId: z.string() }),
    execute: async ({ lessonId }) => {
      if (!can(teacher, 'tool:read_lesson')) return refuse('tool:read_lesson');
      if (!can(teacher, 'lesson:full_text')) return refuse('lesson:full_text');
      // Scoped to the teacher's own pool: a lesson id outside it is "not found", not a leak.
      const lesson = (await lessonPool(teacher, deps.content)).find((l) => l.id === lessonId);
      ctx.recordTool('read_lesson', lesson ? lesson.title : `${lessonId} (not in this teacher’s scope)`);
      if (!lesson) return { error: 'Lesson not found in this teacher’s released lessons' };
      ctx.addSource({ kind: poolKind(teacher), id: lesson.id, title: lesson.title }, lesson.markdown.slice(0, 6000));
      return { title: lesson.title, text: lesson.markdown.slice(0, 6000) };
    },
  });

  const brainLookupTool = createTool({
    id: 'brain_lookup',
    description: "Read the student's own page for a concept: what they understand, where they got stuck, open misconceptions.",
    inputSchema: z.object({ concept: z.string() }),
    execute: async ({ concept }) => {
      if (!can(teacher, 'tool:brain_lookup')) return refuse('tool:brain_lookup');
      const page = await deps.brain.page(conceptKey(concept));
      ctx.recordTool('brain_lookup', page ? `${page.concept} (${page.status})` : `${concept} — no page yet`);
      if (!page) return { found: false };
      ctx.addSource(
        { kind: 'brain', id: page.key, title: page.concept },
        [page.concept, page.sections.in_my_words, page.sections.where_i_got_stuck, ...page.misconceptions.filter((m) => !m.resolved).map((m) => m.claim)].filter(Boolean).join('\n'),
      );
      return {
        found: true,
        concept: page.concept,
        status: page.status,
        inMyWords: page.sections.in_my_words,
        stuck: page.sections.where_i_got_stuck,
        openMisconceptions: page.misconceptions.filter((m) => !m.resolved).map((m) => m.claim),
      };
    },
  });

  const weakestTool = createTool({
    id: 'weakest_concepts',
    description: "List the student's shakiest concepts, to target revision or a quiz.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(5).default(3) }),
    execute: async ({ limit }) => {
      if (!can(teacher, 'tool:weakest_concepts')) return refuse('tool:weakest_concepts');
      const weakest = await deps.brain.weakest(limit);
      ctx.recordTool('weakest_concepts', weakest.map((w) => w.concept).join(', ') || 'none yet');
      return weakest;
    },
  });

  const webSearchTool = createTool({
    id: 'web_search',
    description: 'Search the web. Use for history, applications and current research beyond the syllabus.',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      if (!can(teacher, 'tool:web_search')) return refuse('tool:web_search');
      if (teacherPolicy(teacher).web !== 'explicit_consent') return refuse('tool:web_search');
      if (!deps.webConsented) return refuse('tool:web_search');
      try {
        const results = await webSearch(deps.searxngUrl, query, 4);
        ctx.recordTool('web_search', `"${query}" → ${results.length} results`);
        for (const r of results) ctx.addSource({ kind: 'web', id: r.url, title: r.title, url: r.url }, `${r.title}\n${r.snippet}`);
        return results;
      } catch (error) {
        ctx.recordTool('web_search', `"${query}" → unavailable`);
        return { error: `Web search unavailable: ${(error as Error).message}` };
      }
    },
  });

  const handoffTool = createTool({
    id: 'handoff',
    description: 'Suggest handing the student to another teacher who is a better fit for this question.',
    inputSchema: z.object({ to: z.enum(TEACHER_IDS), reason: z.string() }),
    execute: async ({ to, reason }) => {
      if (!can(teacher, 'tool:handoff')) return refuse('tool:handoff');
      if (to !== teacher) {
        ctx.handoff = { to, reason };
        ctx.recordTool('handoff', `→ ${to}: ${reason}`);
      }
      return { ok: true };
    },
  });

  return { search_lessons: searchLessonsTool, read_lesson: readLessonTool, brain_lookup: brainLookupTool, weakest_concepts: weakestTool, web_search: webSearchTool, handoff: handoffTool };
}

/**
 * The claim block a teacher is allowed to see, filtered claim by claim. Records the verdicts and
 * the rendered block on the context so evidence checks see exactly what the model saw.
 */
export async function claimBlock(teacher: TeacherId, deps: Pick<ToolDeps, 'claims'>, ctx: TurnContext): Promise<void> {
  const capability: CapabilityId = 'claim:wiki_claims';
  if (!can(teacher, capability)) {
    ctx.recordRefusal(capability);
    ctx.contextBlocks.push('WIKI CLAIMS: not available to this teacher.');
    return;
  }
  if (!deps.claims) {
    ctx.contextBlocks.push('WIKI CLAIMS: none compiled yet.');
    return;
  }
  const verdicts = await claimsFor(deps.claims, await evidenceIndexFrom(deps.claims));
  ctx.claimVerdicts = verdicts;
  const assertable = verdicts.filter((v) => v.assertable).length;
  ctx.recordTool('wiki_claims', `${assertable} of ${verdicts.length} claims carry usable provenance`);
  // Shielded: the block carries withheld claims' text, so it must never count as support.
  ctx.shieldedBlocks.push(renderClaims(verdicts));
}