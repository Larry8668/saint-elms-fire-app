import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  brainProposalSchema,
  conceptKey,
  type ChatAttachment,
  type ConceptPage,
  type Evidence,
  type IngestResult,
  type Lesson,
  type LintFinding,
} from '@sef/shared';
import { z } from 'zod';
import { generateStructured } from '../agents/factory';
import { BRAIN_KEEPER_INSTRUCTIONS, QUIZ_INSTRUCTIONS } from '../agents/prompts';
import { log } from '../config';
import { excerptFor, queryTerms, searchLessons } from '../content/search';
import type { ContentStore } from '../content/store';
import { readJson, writeJson } from '../lib/fs';
import { resolveModel } from '../models/registry';
import type { Session } from '../sessions/store';
import type { SettingsStore } from '../settings/store';
import { applyOps } from './applier';
import { buildCourseGraph, type CourseGraph } from './course-graph';
import { buildGraphView } from './graph';
import { lintBrain } from './lint';
import { computeStatus } from './mastery';
import { validateProposal } from './validator';
import type { BrainVault } from './vault';

const MAX_ALLOWED_CONCEPTS = 40;
const LESSON_EXCERPT_CHARS = 1800;

const NotesReadingSchema = z.object({
  topic: z.string().describe('What the notes are about, in a few words'),
  transcription: z.string().describe('Faithful transcription of the handwritten or printed notes, including formulas in LaTeX'),
  concepts: z.array(z.string()).describe('Physics or maths concepts that appear in the notes'),
});

/** The model writes the correct option as text (easier for small models than an index); code maps it back. */
const QuizDraftSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.string()),
        correct_option: z.string().describe('Copy the correct option text exactly'),
        explanation: z.string().optional(),
      }),
    )
    .max(4),
});

interface QuizQuestion {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}
interface Quiz {
  id: string;
  key: string;
  concept: string;
  createdAt: string;
  model: string;
  questions: QuizQuestion[];
}

/** Keeps only well-formed questions: four distinct options, one of which is the stated answer. */
function finalizeQuestions(draft: z.infer<typeof QuizDraftSchema>): QuizQuestion[] {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return draft.questions.flatMap((q) => {
    const options = [...new Set(q.options.map((o) => o.trim()).filter(Boolean))].slice(0, 4);
    const answerIndex = options.findIndex((o) => norm(o) === norm(q.correct_option));
    if (options.length < 3 || answerIndex < 0) return [];
    return [{ question: q.question.trim(), options, answerIndex, explanation: q.explanation?.trim() || `The answer is "${options[answerIndex]}".` }];
  });
}

/**
 * The second brain: deterministic engine (graph, validator, mastery, lint) plus
 * model-driven steps (brain keeper, notes reader, quiz master) that only ever propose.
 */
export class BrainService {
  private graphCache: { lessons: Lesson[]; graph: CourseGraph } | null = null;

  constructor(
    private readonly content: ContentStore,
    private readonly vault: BrainVault,
    private readonly settings: SettingsStore,
    private readonly quizzesDir: string,
  ) {}

  async courseGraph(): Promise<CourseGraph> {
    const lessons = await this.content.academicLessons();
    if (this.graphCache?.lessons !== lessons) this.graphCache = { lessons, graph: buildCourseGraph(lessons) };
    return this.graphCache.graph;
  }

  page(key: string) {
    return this.vault.get(key);
  }

  async pages(): Promise<ConceptPage[]> {
    return [...(await this.vault.all()).values()].sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async graph() {
    return buildGraphView(await this.courseGraph(), await this.vault.all(), await this.content.installed());
  }

  async lint(): Promise<LintFinding[]> {
    return lintBrain(await this.vault.all(), await this.courseGraph());
  }

  log(limit?: number) {
    return this.vault.readLog(limit);
  }

  async weakest(limit = 3) {
    const rank = { shaky: 0, met: 1, solid: 2, unseen: 3 } as const;
    return [...(await this.vault.all()).values()]
      .map((p) => ({ key: p.key, concept: p.concept, status: computeStatus(p), open: p.misconceptions.filter((m) => !m.resolved).length }))
      .sort((a, b) => rank[a.status] - rank[b.status] || b.open - a.open)
      .slice(0, limit);
  }

  /** Brain context for a teacher: pages for the given concepts plus open misconceptions. */
  async contextFor(conceptKeys: string[]): Promise<string> {
    const pages = await this.vault.all();
    const relevant = conceptKeys.map((k) => pages.get(k)).filter((p): p is ConceptPage => Boolean(p)).slice(0, 6);
    const open = [...pages.values()].flatMap((p) => p.misconceptions.filter((m) => !m.resolved).map((m) => ({ page: p, m }))).slice(0, 5);
    if (!relevant.length && !open.length) return 'STUDENT BRAIN: empty so far — this student has not met these concepts yet.';
    const pageLines = relevant.map((p) => `- ${p.concept} [${computeStatus(p)}]: ${p.sections.in_my_words || '(no notes yet)'}`);
    const openLines = open.map(({ page, m }) => `- ${page.concept}: student believed "${m.claim}" (course: ${m.course})`);
    return [`STUDENT BRAIN:`, ...pageLines, openLines.length ? `OPEN MISCONCEPTIONS:\n${openLines.join('\n')}` : ''].filter(Boolean).join('\n');
  }

  /** Concepts allowed for an ingest: those from touched lessons, plus any course concept named in the text. */
  private async allowedConcepts(touched: Lesson[], text: string): Promise<Map<string, string>> {
    const graph = await this.courseGraph();
    const allowed = new Map<string, string>();
    for (const lesson of touched) {
      for (const label of lesson.concepts) {
        const key = conceptKey(label);
        const concept = graph.concepts.get(key);
        if (concept) allowed.set(key, concept.label);
      }
    }
    const lower = text.toLowerCase();
    for (const concept of graph.concepts.values()) {
      if (allowed.size >= MAX_ALLOWED_CONCEPTS) break;
      if (concept.label.length > 4 && lower.includes(concept.label.toLowerCase())) allowed.set(concept.key, concept.label);
    }
    return allowed;
  }

  private async runIngest(opts: {
    evidence: Evidence;
    touched: Lesson[];
    material: string;
    title: string;
  }): Promise<IngestResult> {
    const settings = await this.settings.get();
    const resolved = resolveModel(settings, 'brain', { think: true });
    const allowed = await this.allowedConcepts(opts.touched, opts.material);
    const pages = await this.vault.all();
    if (!allowed.size) {
      log.info('brain_ingest_skipped', { reason: 'no concepts in scope', ref: opts.evidence.ref });
      return { trigger: { kind: opts.evidence.kind, ref: opts.evidence.ref }, applied: [], rejected: [], diff: [], model: resolved.label, durationMs: 0 };
    }

    const openMisconceptions = [...allowed.keys()]
      .flatMap((k) => pages.get(k)?.misconceptions.filter((m) => !m.resolved).map((m) => `- ${pages.get(k)!.concept}: "${m.claim}"`) ?? [])
      .join('\n');
    const terms = queryTerms(opts.material);
    const lessonText = opts.touched
      .slice(0, 2)
      .map((l) => `### ${l.title}\n${excerptFor(l, terms, LESSON_EXCERPT_CHARS)}`)
      .join('\n\n');

    const prompt = [
      `ALLOWED CONCEPTS: ${[...allowed.values()].join(' | ')}`,
      openMisconceptions ? `OPEN MISCONCEPTIONS:\n${openMisconceptions}` : 'OPEN MISCONCEPTIONS: none',
      `LESSON TEXT (ground truth):\n${lessonText || '(none)'}`,
      `MATERIAL FROM THE STUDENT:\n${opts.material}`,
    ].join('\n\n');

    const labels = [...allowed.values()] as [string, ...string[]];
    const { object, ms } = await generateStructured({
      agentId: 'brain-keeper',
      instructions: BRAIN_KEEPER_INSTRUCTIONS,
      resolved,
      prompt,
      schema: brainProposalSchema(labels),
    });

    const { ops, rejected } = validateProposal(object, { allowed, pages, touchedLessons: opts.touched, evidence: opts.evidence });
    const diff = await applyOps(this.vault, ops);
    const created = diff.filter((d) => d.change === 'created').length;
    const flagged = ops.filter((o) => o.op === 'flag_misconception').length;
    await this.vault.appendLog({
      kind: opts.evidence.kind,
      title: opts.title,
      detail: `${diff.length} pages touched (${created} new), ${flagged} misconception${flagged === 1 ? '' : 's'} flagged, ${rejected.length} proposal${rejected.length === 1 ? '' : 's'} rejected by the validator. Model: ${resolved.label}.`,
    });
    log.info('brain_ingested', { ref: opts.evidence.ref, applied: ops.length, rejected: rejected.length, pages: diff.length, ms });
    return { trigger: { kind: opts.evidence.kind, ref: opts.evidence.ref }, applied: ops, rejected, diff, model: resolved.label, durationMs: ms };
  }

  async ingestSession(session: Session): Promise<IngestResult> {
    const fresh = session.turns.slice(session.ingestedTurns);
    const lessons = (await Promise.all(session.lessonIds.map((id) => this.content.lesson(id)))).filter((l): l is Lesson => Boolean(l));
    const transcript = fresh.map((t) => `${t.role === 'user' ? 'Student' : 'Teacher'}: ${t.content}`).join('\n');
    return this.runIngest({
      evidence: { kind: 'session', ref: session.id, at: new Date().toISOString(), note: `${session.teacher} session` },
      touched: lessons,
      material: transcript,
      title: `${session.teacher[0].toUpperCase()}${session.teacher.slice(1)} session: ${fresh.find((t) => t.role === 'user')?.content.slice(0, 60) ?? 'conversation'}`,
    });
  }

  /** Photo of notes → vision reader transcribes → brain keeper proposes. Two agents, one pipeline. */
  async capture(image: ChatAttachment, note?: string): Promise<IngestResult & { reading: z.infer<typeof NotesReadingSchema> }> {
    const settings = await this.settings.get();
    const vision = resolveModel(settings, 'vision');
    const { object: reading } = await generateStructured({
      agentId: 'notes-reader',
      instructions: 'You read photos of a student\'s handwritten or printed study notes and transcribe them faithfully. Do not add content that is not on the page.',
      resolved: vision,
      prompt: `Transcribe these notes.${note ? ` The student says: ${note}` : ''}`,
      images: [image],
      schema: NotesReadingSchema,
    });
    const pool = await this.content.academicLessons();
    const touched = searchLessons(pool, `${reading.topic} ${reading.concepts.join(' ')}`, 3).map((h) => h.lesson);
    const result = await this.runIngest({
      evidence: { kind: 'capture', ref: `capture-${Date.now()}`, at: new Date().toISOString(), note: reading.topic },
      touched,
      material: `Photo of the student's own notes on "${reading.topic}":\n${reading.transcription}${note ? `\nStudent's comment: ${note}` : ''}`,
      title: `Captured notes: ${reading.topic}`,
    });
    return { ...result, reading };
  }

  async createQuiz(key: string) {
    const graph = await this.courseGraph();
    const concept = graph.concepts.get(key);
    if (!concept) throw new Error(`Unknown concept ${key}`);
    const page = await this.vault.get(key);
    const settings = await this.settings.get();
    const resolved = resolveModel(settings, 'tutor');
    const lessonText = concept.mentions.slice(0, 2).map((l) => `### ${l.title}\n${l.markdown.slice(0, 3500)}`).join('\n\n');
    const open = page?.misconceptions.filter((m) => !m.resolved).map((m) => m.claim).join('; ');
    const { object } = await generateStructured({
      agentId: 'quiz-master',
      instructions: QUIZ_INSTRUCTIONS,
      resolved,
      prompt: `CONCEPT: ${concept.label}\n${open ? `OPEN MISCONCEPTION: ${open}\n` : ''}Write 3 questions.\n\nLESSON TEXT:\n${lessonText}`,
      schema: QuizDraftSchema,
    });
    const questions = finalizeQuestions(object);
    if (!questions.length) throw new Error('The model did not produce any well-formed questions. Try again.');
    const quiz: Quiz = { questions, id: randomUUID(), key, concept: concept.label, createdAt: new Date().toISOString(), model: resolved.label };
    await writeJson(path.join(this.quizzesDir, `${quiz.id}.json`), quiz);
    log.info('quiz_created', { key, questions: quiz.questions.length });
    return {
      id: quiz.id,
      key,
      concept: quiz.concept,
      model: quiz.model,
      questions: quiz.questions.map(({ question, options }) => ({ question, options })),
    };
  }

  async submitQuiz(id: string, answers: number[]) {
    const quiz = await readJson<Quiz | null>(path.join(this.quizzesDir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`), null);
    if (!quiz) throw new Error('Quiz not found');
    const score = quiz.questions.reduce((n, q, i) => n + (answers[i] === q.answerIndex ? 1 : 0), 0);
    const graph = await this.courseGraph();
    const concept = graph.concepts.get(quiz.key);
    const diff = await applyOps(this.vault, [
      ...((await this.vault.get(quiz.key)) ? [] : [{ op: 'create_page' as const, key: quiz.key, concept: quiz.concept, courseRefs: concept ? [concept.introducedBy.id] : [] }]),
      { op: 'add_evidence', key: quiz.key, evidence: { kind: 'quiz', ref: quiz.id, at: new Date().toISOString(), score, outOf: quiz.questions.length } },
    ]);
    await this.vault.appendLog({ kind: 'quiz', title: `Quiz on ${quiz.concept}`, detail: `Scored ${score}/${quiz.questions.length}.` });
    return {
      score,
      outOf: quiz.questions.length,
      review: quiz.questions.map((q, i) => ({ correct: q.answerIndex, chosen: answers[i], explanation: q.explanation })),
      diff,
    };
  }
}
