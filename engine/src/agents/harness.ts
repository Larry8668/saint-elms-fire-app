import { conceptKey, TEACHERS, type ChatRequest, type ChatStreamEvent, type Verification, type VerificationCheck } from '@sef/shared';
import type { BrainService } from '../brain/service';
import { errorFields, log } from '../config';
import { searchLessons, type LessonHit } from '../content/search';
import type { ContentStore } from '../content/store';
import { resolveModel, type ResolvedModel } from '../models/registry';
import type { SessionStore } from '../sessions/store';
import type { SettingsStore } from '../settings/store';
import { webSearch, type WebResult } from '../web/searxng';
import { TurnContext } from './context';
import { makeAgent } from './factory';
import { ACADEMIC_REDIRECT, classifyFriendLane, PRIVACY_REFUSAL } from './lanes';
import { toModelMessages } from './messages';
import { teacherInstructions } from './prompts';
import { buildTools } from './tools';
import { checkGrounding, checkPhilosopherFormat, repairPhilosopherFormat } from './validators';

export interface HarnessDeps {
  settings: SettingsStore;
  content: ContentStore;
  brain: BrainService;
  sessions: SessionStore;
  studentName: string;
}

const MAX_STEPS = 4;

function lessonBlock(title: string, hits: LessonHit[]): string {
  if (!hits.length) return `${title}: none matched this question.`;
  return `${title}:\n${hits.map((h) => `### ${h.lesson.title} (id: ${h.lesson.id}, course: ${h.lesson.courseName})\n${h.excerpt}`).join('\n\n')}`;
}

function webBlock(results: WebResult[] | null): string {
  if (results === null) return 'WEB RESULTS: web search is unavailable right now — use [course] lines only and say the web was unreachable.';
  if (!results.length) return 'WEB RESULTS: no results.';
  return `WEB RESULTS:\n${results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n${r.snippet}`).join('\n')}`;
}

/**
 * One chat turn, end to end. Deterministic steps (lanes, retrieval, validation)
 * wrap the model so the teachers' contracts hold regardless of which model is plugged in.
 */
export async function runChatTurn(req: ChatRequest, deps: HarnessDeps, emit: (event: ChatStreamEvent) => void): Promise<void> {
  const started = Date.now();
  const ctx = new TurnContext(emit);
  const settings = await deps.settings.get();
  const latest = req.messages.at(-1);
  if (!latest || latest.role !== 'user') throw new Error('Last message must be from the user');
  const question = latest.content.trim();
  const hasImage = Boolean(latest.attachments?.length);

  const finish = async (text: string, resolved: ResolvedModel | null, checks: VerificationCheck[], lane?: Verification['lane']) => {
    const verification: Verification = {
      model: resolved?.modelId ?? 'rules',
      provider: resolved?.provider.label ?? 'Deterministic lane check',
      sources: [...ctx.sources.values()],
      checks,
      toolCalls: ctx.toolCalls,
      handoff: ctx.handoff,
      lane,
    };
    await deps.sessions.appendTurn(req.sessionId, req.teacher, latest, text, verification.sources, [...ctx.lessonIds]);
    emit({ type: 'done', text, verification });
    log.info('chat_turn_done', { teacher: req.teacher, ms: Date.now() - started, sources: verification.sources.length, tools: ctx.toolCalls.length, lane });
  };

  // Friend: deterministic boundaries before any model call.
  if (req.teacher === 'friend' && !hasImage) {
    const lane = classifyFriendLane(question);
    if (lane === 'privacy') return finish(PRIVACY_REFUSAL, null, [{ id: 'privacy', label: 'Privacy rule applied before the model', passed: true }], 'refused');
    if (lane === 'academic') {
      ctx.handoff = { to: 'guide', reason: 'Academic question' };
      return finish(ACADEMIC_REDIRECT, null, [{ id: 'lane', label: 'Routed by lane check, no model call', passed: true }], 'redirected');
    }
  }

  // Context assembly: retrieval happens up front so even models weak at tool use stay grounded.
  ctx.status('Reading your lessons…');
  const pool = req.teacher === 'friend' ? await deps.content.supportLessons() : await deps.content.academicLessons();
  const hits = searchLessons(pool, question, 3);
  for (const h of hits) ctx.addSource({ kind: req.teacher === 'friend' ? 'support' : 'lesson', id: h.lesson.id, title: h.lesson.title });

  const blocks: string[] = [];
  if (req.teacher === 'friend') {
    blocks.push(lessonBlock('UNIVERSITY NOTES', hits));
  } else {
    blocks.push(lessonBlock('RELEASED LESSONS', hits));
    const keys = hits.flatMap((h) => h.lesson.concepts.map(conceptKey));
    blocks.push(await deps.brain.contextFor(keys));
  }

  let webResults: WebResult[] | null = null;
  if (req.teacher === 'philosopher') {
    ctx.status('Searching the web…');
    try {
      webResults = await webSearch(settings.searxngUrl, question, 4);
      ctx.recordTool('web_search', `"${question.slice(0, 60)}" → ${webResults.length} results`);
      for (const r of webResults) ctx.addSource({ kind: 'web', id: r.url, title: r.title, url: r.url });
    } catch (error) {
      log.warn('web_search_unavailable', errorFields(error));
      ctx.recordTool('web_search', 'unavailable — answering from the course only');
    }
    blocks.push(webBlock(webResults));
  }

  const resolved = resolveModel(settings, hasImage ? 'vision' : 'tutor');
  const instructions = `${teacherInstructions(req.teacher, deps.studentName)}\n\n---\n${blocks.join('\n\n')}`;
  const agent = makeAgent(req.teacher, instructions, resolved, buildTools(req.teacher, { content: deps.content, brain: deps.brain, searxngUrl: settings.searxngUrl }, ctx));

  ctx.status(`${TEACHERS[req.teacher].name} is thinking…`);
  const prompt = hasImage && !question ? 'What is in this image, and how does it connect to my lessons?' : question;
  const stream = await agent.stream(toModelMessages(req.messages, prompt) as never, {
    maxSteps: MAX_STEPS,
    providerOptions: resolved.providerOptions as never,
    modelSettings: { temperature: 0.4 },
  });

  let text = '';
  for await (const chunk of stream.textStream) {
    text += chunk;
    emit({ type: 'delta', text: chunk });
  }
  text = text.trim() || "I couldn't put an answer together just now. Could you rephrase that?";

  const checks: VerificationCheck[] = [];
  if (req.teacher === 'philosopher') {
    let format = checkPhilosopherFormat(text);
    if (format.some((c) => !c.passed)) {
      text = repairPhilosopherFormat(text, Boolean(webResults?.length));
      format = checkPhilosopherFormat(text).map((c) => ({ ...c, detail: c.passed ? 'Repaired by validator' : c.detail }));
    }
    checks.push(...format);
    checks.push({ id: 'web', label: 'Web search reachable', passed: webResults !== null, detail: webResults ? `${webResults.length} results` : 'offline' });
  } else {
    checks.push(checkGrounding(ctx.lessonIds.size, text));
    checks.push({ id: 'released-only', label: 'Only released lessons were searched', passed: true, detail: 'Unreleased lessons are never on this device' });
  }
  if (hasImage) checks.push({ id: 'vision', label: 'Image read on-device', passed: resolved.provider.kind === 'ollama', detail: resolved.label });

  await finish(text, resolved, checks, 'answered');
}
