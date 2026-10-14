import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { conceptKey, TEACHER_IDS, type TeacherId } from '@sef/shared';
import { z } from 'zod';
import type { BrainService } from '../brain/service';
import type { ContentStore } from '../content/store';
import { searchLessons } from '../content/search';
import { webSearch } from '../web/searxng';
import type { TurnContext } from './context';

export interface ToolDeps {
  content: ContentStore;
  brain: BrainService;
  searxngUrl: string;
}

/**
 * Tools are built per turn so every call is recorded on the TurnContext — that is
 * what powers the verification panel ("what did the teacher actually look at?").
 */
export function buildTools(teacher: TeacherId, deps: ToolDeps, ctx: TurnContext): ToolsInput {
  const searchLessonsTool = createTool({
    id: 'search_lessons',
    description: "Search the student's released lessons. Returns titles, ids and matching excerpts.",
    inputSchema: z.object({ query: z.string().describe('What to look for') }),
    execute: async ({ query }) => {
      const pool = teacher === 'friend' ? await deps.content.supportLessons() : await deps.content.academicLessons();
      const hits = searchLessons(pool, query, 3);
      ctx.recordTool('search_lessons', `"${query}" → ${hits.length} lesson${hits.length === 1 ? '' : 's'}`);
      for (const h of hits) ctx.addSource({ kind: teacher === 'friend' ? 'support' : 'lesson', id: h.lesson.id, title: h.lesson.title });
      return hits.map((h) => ({ lessonId: h.lesson.id, title: h.lesson.title, course: h.lesson.courseName, excerpt: h.excerpt }));
    },
  });

  const readLessonTool = createTool({
    id: 'read_lesson',
    description: 'Read the full text of one released lesson by id.',
    inputSchema: z.object({ lessonId: z.string() }),
    execute: async ({ lessonId }) => {
      const lesson = await deps.content.lesson(lessonId);
      ctx.recordTool('read_lesson', lesson ? lesson.title : `${lessonId} (not released)`);
      if (!lesson) return { error: 'Lesson not found among released lessons' };
      ctx.addSource({ kind: 'lesson', id: lesson.id, title: lesson.title });
      return { title: lesson.title, text: lesson.markdown.slice(0, 6000) };
    },
  });

  const brainLookupTool = createTool({
    id: 'brain_lookup',
    description: "Read the student's own page for a concept: what they understand, where they got stuck, open misconceptions.",
    inputSchema: z.object({ concept: z.string() }),
    execute: async ({ concept }) => {
      const page = await deps.brain.page(conceptKey(concept));
      ctx.recordTool('brain_lookup', page ? `${page.concept} (${page.status})` : `${concept} — no page yet`);
      if (!page) return { found: false };
      ctx.addSource({ kind: 'brain', id: page.key, title: page.concept });
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
      try {
        const results = await webSearch(deps.searxngUrl, query, 4);
        ctx.recordTool('web_search', `"${query}" → ${results.length} results`);
        for (const r of results) ctx.addSource({ kind: 'web', id: r.url, title: r.title, url: r.url });
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
      if (to !== teacher) {
        ctx.handoff = { to, reason };
        ctx.recordTool('handoff', `→ ${to}: ${reason}`);
      }
      return { ok: true };
    },
  });

  switch (teacher) {
    case 'friend':
      return { search_lessons: searchLessonsTool, handoff: handoffTool };
    case 'guide':
      return { search_lessons: searchLessonsTool, read_lesson: readLessonTool, brain_lookup: brainLookupTool, weakest_concepts: weakestTool, handoff: handoffTool };
    case 'philosopher':
      return { search_lessons: searchLessonsTool, web_search: webSearchTool, brain_lookup: brainLookupTool, handoff: handoffTool };
  }
}
