import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CONTRACT_VERSION,
  type BrainDiffEntry,
  type ConceptPage,
  type Lesson,
  type LintFinding,
  type ProfileIdentity,
  type WikiProposal,
} from '@sef/shared';
import { z } from 'zod';
import { generateStructured } from '../agents/factory';
import { QUIZ_INSTRUCTIONS } from '../agents/prompts';
import { log } from '../config';
import type { ContentStore } from '../content/store';
import { readJson, writeJson } from '../lib/fs';
import { resolveModel } from '../models/registry';
import type { Session } from '../sessions/store';
import type { SettingsReader } from '../settings/store';
import { buildCourseGraph, type CourseGraph } from './course-graph';
import { buildGraphView } from './graph';
import { lintBrain } from './lint';
import { computeStatus } from './mastery';
import { writeProposalRecord } from './proposals';
import { countChars } from './sources/limits';
import { recordVisionText } from './sources/extract';
import type { SourceIngestor } from './sources/ingest';
import type { BrainVault } from './vault';
import { readPageFile } from './wiki-page-format';
import type { PageChange, WikiStore } from './wiki-store';

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

/** A quiz result is persisted as its own artifact so evidenceIds can resolve to real scores. */
interface QuizResult {
  id: string;
  quizId: string;
  key: string;
  score: number;
  outOf: number;
  at: string;
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
 * model-driven steps (notes reader, quiz master) that only ever propose. Every model
 * update reaches the vault as a WikiProposal through the compiler — there is no other
 * writer for keeper-authored content.
 */
export class BrainService {
  private graphCache: { lessons: Lesson[]; graph: CourseGraph } | null = null;

  constructor(
    private readonly content: ContentStore,
    private readonly vault: BrainVault,
    private readonly settings: SettingsReader,
    private readonly quizzesDir: string,
    private readonly deps: {
      wiki: WikiStore;
      sources: SourceIngestor;
      identity: () => Promise<ProfileIdentity>;
    },
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

  /**
   * Maps a compiled proposal's page changes onto the diff shape the desktop renders.
   * `statusBefore` is read back from the page's history file — the version the commit just
   * archived — so the before/after the student sees is the truth on disk, not a guess.
   */
  async pageDiffs(changes: PageChange[]): Promise<BrainDiffEntry[]> {
    const diff: BrainDiffEntry[] = [];
    for (const change of changes) {
      if (change.change === 'unchanged') continue;
      const snapshot = await this.deps.wiki.readPage(change.id);
      if (!snapshot) continue;
      const view = snapshot.metadata ? await this.vault.conceptView(snapshot.metadata, snapshot.body) : (snapshot.legacy ?? null);
      const before = change.revisionBefore ? await this.pageAtRevision(change.id, change.revisionBefore) : null;
      const beforeView = before ? (before.metadata ? await this.vault.conceptView(before.metadata, before.body) : before.legacy) : null;
      diff.push({
        key: change.id,
        concept: view?.concept ?? snapshot.metadata?.title ?? change.id,
        change: change.change,
        before: before?.raw ?? undefined,
        after: snapshot.raw,
        statusBefore: computeStatus(beforeView),
        statusAfter: computeStatus(view),
      });
    }
    return diff;
  }

  private async pageAtRevision(id: string, revision: string) {
    const saved = await this.deps.wiki.readPageRevision(id, revision);
    if (!saved) return null;
    const parsed = readPageFile(saved.raw);
    if (parsed.format === 2) return { metadata: parsed.metadata, body: parsed.body, raw: saved.raw, legacy: null };
    if (parsed.format === 1) return { metadata: null, body: parsed.body, raw: saved.raw, legacy: parsed.legacy };
    return null;
  }

  /**
   * Freezes the un-reflected turns of a session as a session source — the committed
   * transcript range travels with it — without compiling anything. Reflect uses this so
   * the turns stay pending until the student accepts the proposal they produce.
   */
  async freezeSession(session: Session): Promise<Awaited<ReturnType<SourceIngestor['ingest']>>> {
    const fresh = session.turns.slice(session.ingestedTurns);
    const transcript = fresh.map((t) => `${t.role === 'user' ? 'Student' : 'Teacher'}: ${t.content}`).join('\n');
    const title = `${session.teacher[0]!.toUpperCase()}${session.teacher.slice(1)} session: ${fresh.find((t) => t.role === 'user')?.content.slice(0, 60) ?? 'conversation'}`;
    return this.deps.sources.ingest({
      kind: 'session',
      title,
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode(transcript),
      session: { sessionId: session.id, teacher: session.teacher, firstTurn: session.ingestedTurns, lastTurn: session.turns.length - 1 },
      extraction: { method: 'text', text: transcript },
    });
  }

  /**
   * A fresh vision pass over a kept image source. The transcription is recorded as the
   * source's extraction — the student sees it, can correct it, and only then a compile
   * reads it. Returns null for anything that is not this student's image source.
   */
  async readImageSource(sourceId: string): Promise<{ reading: z.infer<typeof NotesReadingSchema> } | null> {
    const [record, identity] = await Promise.all([this.deps.wiki.readSource(sourceId), this.deps.identity()]);
    if (!record || record.profile.studentId !== identity.studentId || record.kind !== 'image') return null;
    const bytes = await this.deps.wiki.readSourceBytes(record.id);
    if (!bytes) return null;
    const settings = await this.settings.get();
    const vision = resolveModel(settings, 'vision');
    const { object: reading } = await generateStructured({
      agentId: 'notes-reader',
      instructions: 'You read photos of a student\'s handwritten or printed study notes and transcribe them faithfully. Do not add content that is not on the page.',
      resolved: vision,
      prompt: 'Transcribe these notes.',
      images: [{ kind: 'image', mimeType: record.mediaType, data: bytes.toString('base64') }],
      schema: NotesReadingSchema,
    });
    const outcome = recordVisionText(new Uint8Array(bytes), reading.transcription);
    if (outcome.ok) {
      await this.deps.wiki.recordExtraction(
        record.id,
        { method: 'vision', sha256: outcome.result.sha256, chars: countChars(outcome.result.text), partial: outcome.result.partial, ...(outcome.result.note ? { note: outcome.result.note } : {}) },
        outcome.result.text || undefined,
      );
    }
    return { reading };
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
    const at = new Date().toISOString();

    // The result is its own durable artifact: an evidence id on the page resolves to it.
    const resultId = `res_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const result: QuizResult = { id: resultId, quizId: quiz.id, key: quiz.key, score, outOf: quiz.questions.length, at };
    await writeJson(path.join(this.quizzesDir, `${resultId}.json`), result);

    // Every page write goes through the proposal machinery — a format-1 page is upgraded
    // first so the vault holds no legacy bypass writer for evidence either.
    let snapshot = await this.deps.wiki.readPage(quiz.key);
    if (snapshot?.format === 1) {
      await this.deps.wiki.upgradeLegacyPage(quiz.key);
      snapshot = await this.deps.wiki.readPage(quiz.key);
    }
    const meta = snapshot?.metadata ?? null;
    const learner = meta?.learner ?? { inMyWords: '', stuck: '', connections: '', evidenceIds: [] };
    const identity = await this.deps.identity();
    const proposal: WikiProposal = {
      schemaVersion: CONTRACT_VERSION,
      id: `prop_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      profile: identity,
      sourceIds: [resultId],
      conventionRevision: (await this.deps.wiki.readConventions()).conventions.revision,
      createdAt: at,
      baseRevisions: { [quiz.key]: snapshot?.revision ?? null },
      operations: [
        {
          op: 'upsert_page',
          page: {
            id: quiz.key,
            kind: 'concept',
            title: meta?.title ?? quiz.concept,
            summary: meta?.summary ?? `${quiz.concept} — tracked from quiz results.`,
            markdown: snapshot?.body ?? `# ${quiz.concept}\n`,
            courseRefs: meta?.courseRefs ?? (concept ? [{ programmeId: identity.programmeId, courseId: concept.introducedBy.courseId, conceptKey: quiz.key, lessonId: concept.introducedBy.id }] : []),
            claims: meta?.claims ?? [],
            links: meta?.links ?? [],
            learner: { ...learner, evidenceIds: [...new Set([...learner.evidenceIds, resultId])] },
          },
        },
      ],
    };
    const report = await this.deps.wiki.applyProposal(proposal);
    // Even a code-built proposal leaves the same audit trail a keeper proposal does.
    await writeProposalRecord(this.deps.wiki.root, {
      schemaVersion: CONTRACT_VERSION,
      proposal,
      jobId: null,
      state: 'accepted',
      decidedAt: at,
      decidedBy: 'system',
    });
    const diff = await this.pageDiffs(report.pages);
    await this.vault.appendLog({ kind: 'quiz', title: `Quiz on ${quiz.concept}`, detail: `Scored ${score}/${quiz.questions.length}.` });
    return {
      score,
      outOf: quiz.questions.length,
      review: quiz.questions.map((q, i) => ({ correct: q.answerIndex, chosen: answers[i], explanation: q.explanation })),
      diff,
    };
  }
}
