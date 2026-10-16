import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CONTRACT_VERSION,
  TEACHERS,
  type BrainDiffEntry,
  type ConceptPage,
  type LearningEvent,
  type Lesson,
  type LintFinding,
  type PageRecordSummary,
  type PageRecordView,
  type ProfileIdentity,
  type ProposalAcceptance,
  type SourceRecord,
  type WikiPageDraft,
  type WikiProposal,
  type WikiProposalRecord,
} from '@sef/shared';
import { z } from 'zod';
import { generateStructured } from '../agents/factory';
import { QUIZ_INSTRUCTIONS } from '../agents/prompts';
import { log } from '../config';
import type { ContentStore } from '../content/store';
import { readJson, writeJson } from '../lib/fs';
import { sha256Hex } from '../lib/hash';
import { resolveModel } from '../models/registry';
import type { Session } from '../sessions/store';
import type { SettingsReader } from '../settings/store';
import { buildCourseGraph, type CourseGraph } from './course-graph';
import { buildGraphView, type BrainGraphPage } from './graph';
import { pageOrigin } from './growth';
import { lintBrain } from './lint';
import { computeStatus } from './mastery';
import { writeProposalRecord } from './proposals';
import { countChars } from './sources/limits';
import { recordVisionText } from './sources/extract';
import { SourceRejection, type SourceIngestor } from './sources/ingest';
import type { BrainVault } from './vault';
import { VaultConflictError } from './vault-errors';
import { legacyPageSummary, readPageFile, wikiContentFromConceptPage, type PageMetadata } from './wiki-page-format';
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
  /** The submitted options, so a replayed submit can re-render the same review. */
  answers: number[];
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
    return buildGraphView(await this.courseGraph(), await this.skyPages(), await this.content.installed());
  }

  /**
   * Every vault page the sky can draw, with its typed links, provenance and growth-event
   * counts — concepts (course-mapped or personal), syntheses and open questions. Source
   * summary pages are vault records, not stars, so they skip the sky.
   */
  private async skyPages(): Promise<BrainGraphPage[]> {
    const [snapshots, sourceRecords, events] = await Promise.all([this.deps.wiki.listPages(), this.deps.wiki.listSources(), this.deps.wiki.listEvents()]);
    const sources = new Map<string, SourceRecord>(Object.entries(sourceRecords));
    const counts = new Map<string, { collected: number; demonstrated: number }>();
    for (const event of events) {
      const count = counts.get(event.pageId) ?? { collected: 0, demonstrated: 0 };
      if (event.knowledgeOnly) count.collected += 1;
      else count.demonstrated += 1;
      counts.set(event.pageId, count);
    }
    const pages: BrainGraphPage[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.state !== 'ok' && snapshot.state !== 'out_of_band') continue;
      const meta = snapshot.metadata;
      const view = snapshot.legacy ?? (meta?.kind === 'concept' ? await this.vault.conceptView(meta, snapshot.body) : null);
      pages.push({
        id: snapshot.id,
        kind: meta?.kind ?? snapshot.kind,
        title: meta?.title ?? snapshot.legacy?.concept ?? snapshot.id,
        updatedAt: meta?.updatedAt ?? snapshot.legacy?.updated ?? '',
        links: meta?.links ?? (snapshot.legacy?.links ?? []).map((link) => ({ toPageId: link.to, type: link.type, origin: link.origin, why: link.why })),
        origin: meta ? pageOrigin(meta, sources) : 'student',
        view,
        collected: counts.get(snapshot.id)?.collected ?? 0,
        demonstrated: counts.get(snapshot.id)?.demonstrated ?? 0,
      });
    }
    return pages;
  }

  /**
   * The growth ledger, oldest first, optionally narrowed to one page. A page written before
   * the ledger existed (seeded or legacy) gets its first-encounter marker synthesised from its
   * earliest saved revision — attributable to real history, never invented.
   */
  async events(pageId?: string): Promise<LearningEvent[]> {
    const events = await this.deps.wiki.listEvents(pageId);
    if (!pageId || events.some((event) => event.kind === 'encounter')) return events;
    const revisions = await this.deps.wiki.pageRevisions(pageId);
    const oldest = revisions?.revisions.at(-1);
    if (!revisions || !oldest) return events;
    const identity = await this.deps.identity();
    return [
      ...events,
      {
        schemaVersion: CONTRACT_VERSION,
        id: `evt_${sha256Hex(`encounter|${pageId}|${oldest.revision}|first`).slice(0, 24)}`,
        profile: identity,
        pageId,
        at: oldest.at,
        kind: 'encounter' as const,
        actor: 'student' as const,
        evidence: [{ kind: 'revision' as const, ref: oldest.revision }],
        note: 'First page',
        knowledgeOnly: false,
      },
    ];
  }

  /** Every vault page as a list row — all kinds, not only concepts, so personal pages are findable. */
  async records(): Promise<PageRecordSummary[]> {
    const [snapshots, sourceRecords] = await Promise.all([this.deps.wiki.listPages(), this.deps.wiki.listSources()]);
    const sources = new Map<string, SourceRecord>(Object.entries(sourceRecords));
    const records: PageRecordSummary[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.state === 'malformed' || snapshot.state === 'newer_schema') continue;
      const meta = snapshot.metadata;
      if (meta) {
        const view = meta.kind === 'concept' ? await this.vault.conceptView(meta, snapshot.body) : null;
        records.push({
          id: snapshot.id,
          kind: meta.kind,
          title: meta.title,
          summary: meta.summary,
          updatedAt: meta.updatedAt,
          revision: snapshot.revision,
          origin: meta.provenance ? 'legacy' : pageOrigin(meta, sources),
          ...(view ? { status: computeStatus(view), openMisconceptions: view.misconceptions.filter((m) => !m.resolved).length } : {}),
        });
      } else if (snapshot.legacy) {
        records.push({
          id: snapshot.id,
          kind: 'concept',
          title: snapshot.legacy.concept || snapshot.id,
          summary: legacyPageSummary(snapshot.legacy),
          updatedAt: snapshot.legacy.updated,
          revision: snapshot.revision,
          origin: 'legacy',
          status: computeStatus(snapshot.legacy),
          openMisconceptions: snapshot.legacy.misconceptions.filter((m) => !m.resolved).length,
        });
      }
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** One vault page in full — the detail view for any kind, concept or not. */
  async pageRecord(id: string): Promise<PageRecordView | null> {
    const snapshot = await this.deps.wiki.readPage(id);
    if (!snapshot || snapshot.state === 'malformed' || snapshot.state === 'newer_schema') return null;
    const sources = new Map<string, SourceRecord>(Object.entries(await this.deps.wiki.listSources()));
    const meta = snapshot.metadata;
    if (meta) {
      const view = meta.kind === 'concept' ? await this.vault.conceptView(meta, snapshot.body) : null;
      return {
        id: snapshot.id,
        kind: meta.kind,
        title: meta.title,
        summary: meta.summary,
        updatedAt: meta.updatedAt,
        revision: snapshot.revision,
        origin: meta.provenance ? 'legacy' : pageOrigin(meta, sources),
        ...(view ? { status: computeStatus(view), openMisconceptions: view.misconceptions.filter((m) => !m.resolved).length } : {}),
        markdown: snapshot.body,
        courseRefs: meta.courseRefs,
        claims: meta.claims,
        links: meta.links,
        learner: meta.learner,
        sourceIds: meta.sourceIds,
      };
    }
    if (snapshot.legacy) {
      const page = snapshot.legacy;
      return {
        id: snapshot.id,
        kind: 'concept',
        title: page.concept || snapshot.id,
        summary: legacyPageSummary(page),
        updatedAt: page.updated,
        revision: snapshot.revision,
        origin: 'legacy',
        status: computeStatus(page),
        openMisconceptions: page.misconceptions.filter((m) => !m.resolved).length,
        markdown: snapshot.body,
        courseRefs: [],
        claims: [],
        // Legacy links are display projections: they predate required citations, so they are
        // shown verbatim rather than re-stamped as typed links.
        links: page.links.map((link) => ({ toPageId: link.to, type: link.type, origin: link.origin, why: link.why ?? 'Recorded before link reasons existed.', citations: [] })),
        learner: {
          inMyWords: page.sections.in_my_words,
          stuck: page.sections.where_i_got_stuck,
          connections: page.sections.connections,
          evidenceIds: page.evidence.map((entry) => entry.ref),
        },
        sourceIds: [],
      };
    }
    return null;
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
   * Freezes one assistant answer as an 'answer' source — provenance 'model', pinned to the
   * session and turn it came from — and queues its job. Nothing reaches the wiki here:
   * the job's compile files a proposal, and the student's accept is still the only writer.
   * The kept document carries the answer plus the sources and tool trace that produced it,
   * so attribution, source links and anchor metadata survive the save verbatim.
   */
  async saveAnswer(
    session: Session,
    input: { turnIndex?: number; content?: string; title?: string; saveKind?: 'synthesis' | 'question' } = {},
  ): Promise<Awaited<ReturnType<SourceIngestor['ingest']>>> {
    const isAnswer = (t: (typeof session.turns)[number] | undefined): t is (typeof session.turns)[number] => Boolean(t && t.role === 'assistant' && t.content.trim());
    let index = input.turnIndex ?? session.turns.findLastIndex((t) => t.role === 'assistant');
    // A failed turn stays in the student's message list without a stored turn, so a position
    // alone can point at the wrong answer. With the content the student saw, the stored turn
    // it actually names wins; without it, the position is all there is.
    if (input.content !== undefined && (!isAnswer(session.turns[index]) || session.turns[index]!.content !== input.content)) {
      index = session.turns.findLastIndex((t) => t.role === 'assistant' && t.content === input.content);
    }
    const turn = index >= 0 ? session.turns[index] : undefined;
    if (!isAnswer(turn)) {
      throw new SourceRejection('That turn is not a teacher answer to save.', 'not_an_answer', 400);
    }
    const teacher = TEACHERS[session.teacher];
    const question = [...session.turns.slice(0, index)].reverse().find((t) => t.role === 'user')?.content;
    const verification = turn.verification;
    const title = input.title ?? `${teacher.name}: ${(question ?? 'a saved answer').replace(/\s+/g, ' ').slice(0, 80)}`;
    const lines = [
      `# ${title}`,
      '',
      `Teacher: ${teacher.name} (${session.teacher})`,
      `Model: ${verification?.model ?? 'local rules'} via ${verification?.provider ?? 'unknown provider'}`,
      `Session: ${session.id} · turn ${index + 1}`,
      input.saveKind ? `Requested shape: ${input.saveKind}` : null,
      '',
      turn.content.trim(),
      '',
      '## What the answer drew on',
      ...(verification?.sources.length
        ? verification.sources.map(
            (source) =>
              `- [${source.kind}] ${source.id} — ${source.title}` +
              (source.courseName ? ` · ${source.courseName}` : '') +
              (source.section ? ` · section "${source.section.heading}"` : '') +
              (source.url ? ` · ${source.url}` : '') +
              (source.cited === false ? ' (retrieved, not used)' : ''),
          )
        : ['- nothing cited']),
      '',
      '## What it looked at',
      ...(verification?.toolCalls.length ? verification.toolCalls.map((call) => `- ${call.tool}: ${call.summary}`) : ['- no tools ran']),
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
    const result = await this.deps.sources.ingest({
      kind: 'answer',
      title,
      mediaType: 'text/markdown',
      bytes: new TextEncoder().encode(lines),
      session: { sessionId: session.id, teacher: session.teacher, firstTurn: index, lastTurn: index },
      attribution: { creator: `${teacher.name} · ${verification?.model ?? 'local rules'}` },
      extraction: { method: 'text', text: lines },
    });
    log.info('wiki_answer_saved', { sessionId: session.id, turnIndex: index, sourceId: result.source.id, teacher: session.teacher });
    return result;
  }

  /**
   * Restore-as-new-revision, through the proposal machinery like every other write: the old
   * revision's content is rebuilt as a code draft, and `applyProposal` refuses unless the
   * page still sits at the revision the caller read (`baseRevision`). The current file is
   * archived to .history/ first, so restoring can never lose the version it replaced.
   */
  async restorePageRevision(pageId: string, revision: string, baseRevision: string): Promise<ProposalAcceptance> {
    const snapshot = await this.deps.wiki.readPage(pageId);
    if (!snapshot) throw new SourceRejection('No page by that id in this wiki.', 'not_found', 404);
    if (snapshot.revision !== baseRevision) {
      throw new VaultConflictError(`Page ${pageId} is not at the revision you read — refresh before restoring.`, [
        { id: pageId, expected: baseRevision, found: snapshot.revision, reason: snapshot.state === 'out_of_band' ? 'out_of_band' : 'revision_changed' },
      ]);
    }
    const saved = await this.deps.wiki.readPageRevision(pageId, revision);
    if (!saved) throw new SourceRejection('That revision is not in this page’s history.', 'not_found', 404);
    const parsed = readPageFile(saved.raw);
    const at = new Date().toISOString();
    const draft =
      parsed.format === 2
        ? draftFromMetadata(parsed.metadata, parsed.body)
        : parsed.format === 1
          ? draftFromMetadata(wikiContentFromConceptPage(parsed.legacy, at).metadata, parsed.body)
          : null;
    if (!draft) {
      throw new SourceRejection('That revision cannot be restored — it is unreadable to this engine.', 'unreadable_revision', 409);
    }
    const proposal: WikiProposal = {
      schemaVersion: CONTRACT_VERSION,
      id: `prop_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      profile: await this.deps.identity(),
      // The restore's "source" is the page's own history — there is no outside material.
      sourceIds: [pageId],
      conventionRevision: (await this.deps.wiki.readConventions()).conventions.revision,
      createdAt: at,
      baseRevisions: { [pageId]: baseRevision },
      operations: [{ op: 'upsert_page', page: draft }],
    };
    const report = await this.deps.wiki.applyProposal(proposal);
    // A code-built proposal still leaves the same audit trail a keeper proposal does, plus
    // a plain-language entry so the timeline says what this write was for.
    await this.deps.wiki.appendLog({
      kind: 'wiki',
      title: `Restored ${pageId} from revision ${revision}`,
      detail: report.committed ? `Written on top of ${baseRevision} — that version is kept in history.` : 'The page already said exactly that, so nothing changed.',
    });
    const record: WikiProposalRecord = {
      schemaVersion: CONTRACT_VERSION,
      proposal,
      jobId: null,
      state: 'accepted',
      decidedAt: at,
      decidedBy: 'student',
      note: `Restored from revision ${revision}`,
    };
    await writeProposalRecord(this.deps.wiki.root, record);
    log.info('wiki_page_restored', { pageId, revision, baseRevision });
    const diff = await this.pageDiffs(report.pages);
    return { record, report, diff };
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

  async submitQuiz(id: string, answers: number[], attemptId?: string) {
    const quiz = await readJson<Quiz | null>(path.join(this.quizzesDir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`), null);
    if (!quiz) throw new Error('Quiz not found');
    const score = quiz.questions.reduce((n, q, i) => n + (answers[i] === q.answerIndex ? 1 : 0), 0);
    const graph = await this.courseGraph();
    const concept = graph.concepts.get(quiz.key);
    const at = new Date().toISOString();

    // The result id is derived from the attempt, so a retried submit (same client attempt, or
    // byte-identical answers with no attempt id) replays the stored outcome instead of filing
    // duplicate evidence — one attempt is one review signal, however many times it is sent.
    const resultId = `res_${sha256Hex(`${quiz.id}:${attemptId ?? answers.join('.')}`).slice(0, 20)}`;
    const existing = await readJson<QuizResult | null>(path.join(this.quizzesDir, `${resultId}.json`), null);
    if (existing) {
      return {
        score: existing.score,
        outOf: existing.outOf,
        review: quiz.questions.map((q, i) => ({ correct: q.answerIndex, chosen: existing.answers[i], explanation: q.explanation })),
        diff: [] as BrainDiffEntry[],
        replayed: true,
      };
    }
    const result: QuizResult = { id: resultId, quizId: quiz.id, key: quiz.key, score, outOf: quiz.questions.length, at, answers };
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
      replayed: false,
    };
  }
}

/**
 * Rebuilds a page draft verbatim from stored metadata + body — what a restore proposes.
 * Kind fields that cannot be satisfied (a generated page with no surviving source ids)
 * refuse rather than fabricate.
 */
function draftFromMetadata(metadata: PageMetadata, body: string): WikiPageDraft | null {
  const base = {
    id: metadata.id,
    title: metadata.title,
    summary: metadata.summary,
    markdown: body,
    courseRefs: metadata.courseRefs,
    claims: metadata.claims,
    links: metadata.links,
  };
  switch (metadata.kind) {
    case 'concept':
      return { ...base, kind: 'concept', learner: metadata.learner ?? { inMyWords: '', stuck: '', connections: '', evidenceIds: [] } };
    case 'source_summary':
      return metadata.sourceIds.length ? { ...base, kind: 'source_summary', sourceIds: metadata.sourceIds } : null;
    case 'synthesis':
      return metadata.sourceIds.length ? { ...base, kind: 'synthesis', sourceIds: metadata.sourceIds } : null;
    case 'question':
      return { ...base, kind: 'question', sourceIds: metadata.sourceIds };
  }
}
