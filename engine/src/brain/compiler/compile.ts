import { ProposalListSchema, CONTRACT_VERSION, type ProfileIdentity, type ProposalList, type SourceRecord, type WikiJob, type WikiProposalRecord } from '@sef/shared';
import { generateStructured } from '../../agents/factory';
import { errorFields, log } from '../../config';
import type { ContentStore } from '../../content/store';
import { resolveModel } from '../../models/registry';
import type { SettingsReader } from '../../settings/store';
import { buildCourseGraph, type CourseGraph } from '../course-graph';
import { decideProposal, listProposalRecords, pendingProposalRecord, readProposalRecord, writeProposalRecord } from '../proposals';
import { extractPdf, extractText } from '../sources/extract';
import { advanceJob, jobStore, JobConflictError, JobStateError, type JobStore } from '../sources/jobs';
import { openPdf } from '../sources/pdf';
import type { Limits } from '../sources/limits';
import { VaultConflictError } from '../vault-errors';
import type { PageSnapshot, ProposalReport, WikiStore } from '../wiki-store';
import { planProposal } from '../wiki-plan';
import { keeperContext, type KeeperContext } from './context';
import { KeeperDraftSchema, WIKI_KEEPER_INSTRUCTIONS, type KeeperDraft } from './draft';
import type { SourceBlob } from './citations';
import { normalizeDraft, type DroppedItem } from './normalize';

export interface CompileResult {
  job: WikiJob;
  proposalId: string | null;
  /** Draft entries the deterministic pass dropped, with the reason each was refused. */
  dropped: DroppedItem[];
  /** Set when the proposal was auto-committed on behalf of an explicit student gesture. */
  report?: ProposalReport;
  model: string;
  durationMs: number;
}

export class ProposalStateError extends Error {}

type ProposeFn = (prompt: string) => Promise<KeeperDraft>;

/**
 * The compiler stage of the wiki pipeline: a durable job's sources are read, the keeper
 * drafts page updates, code turns that into a WikiProposal, and only an accepted proposal
 * ever reaches the vault — through the journaled apply path.
 */
export class WikiCompiler {
  private readonly jobs: JobStore;
  private readonly proposeFn: ProposeFn;
  private graphCache: { graph: CourseGraph } | null = null;

  constructor(
    private readonly store: WikiStore,
    private readonly deps: {
      settings: SettingsReader;
      content: ContentStore;
      profile: () => Promise<ProfileIdentity>;
      /** Test seam: produce the keeper draft without a model. */
      propose?: ProposeFn;
      limits?: Limits;
    },
  ) {
    this.jobs = jobStore(store.root);
    this.proposeFn = deps.propose ?? ((prompt) => this.proposeWithModel(prompt));
  }

  private async courseGraph(): Promise<CourseGraph> {
    if (!this.graphCache) this.graphCache = { graph: buildCourseGraph(await this.deps.content.academicLessons()) };
    return this.graphCache.graph;
  }

  private async proposeWithModel(prompt: string): Promise<KeeperDraft> {
    const settings = await this.deps.settings.get();
    const resolved = resolveModel(settings, 'brain', { think: true });
    const { object } = await generateStructured({
      agentId: 'wiki-keeper',
      instructions: WIKI_KEEPER_INSTRUCTIONS,
      resolved,
      prompt,
      schema: KeeperDraftSchema,
    });
    return object;
  }

  private async assertOwns(job: WikiJob | null): Promise<WikiJob> {
    if (!job) throw new JobConflictError(`Job does not exist.`);
    const identity = await this.deps.profile();
    if (job.profile.studentId !== identity.studentId) throw new JobConflictError(`Job ${job.id} does not exist.`);
    return job;
  }

  /**
   * Runs the compile stage of one job: extracting → compiling → awaiting_review with a
   * filed proposal, or → no_changes when nothing survives validation. `autoAccept` is used
   * only for the student's own explicit gestures (Reflect, capture) where clicking the
   * button *is* the review.
   */
  async compileJob(jobId: string, opts: { autoAccept?: boolean } = {}): Promise<CompileResult> {
    let job = await this.assertOwns(await this.jobs.read(jobId));
    if (job.stage === 'queued') {
      job = await advanceJob(this.jobs, jobId, 'extracting', { progress: job.progress });
    }
    if (job.stage !== 'extracting' && job.stage !== 'awaiting_source_review') {
      throw new JobStateError(`Job ${jobId} is ${job.stage}; only an extracted job can be compiled.`);
    }
    job = await advanceJob(this.jobs, jobId, 'compiling');

    const started = Date.now();
    let model = 'keeper';
    try {
      const records = await this.jobSources(job);
      const blobs = await this.readBlobs(records);
      if (!blobs.some((blob) => blob.text.trim())) {
        job = await advanceJob(this.jobs, jobId, 'failed', { error: 'Nothing could be read from these sources.' });
        return { job, proposalId: null, dropped: [], model, durationMs: 0 };
      }

      const material = blobs.map((blob) => blob.text).join('\n\n');
      const ctx = await keeperContext(this.store, blobs, { material, courseGraph: await this.courseGraph() });
      const { object, ms, modelLabel } = await this.propose(ctx);
      model = modelLabel;

      const identity = await this.deps.profile();
      const normalized = normalizeDraft(object, ctx, {
        profile: identity,
        sourceIds: job.sourceIds,
        courseGraph: await this.courseGraph(),
        at: new Date().toISOString(),
      });

      if (!normalized) {
        job = await advanceJob(this.jobs, jobId, 'no_changes', { progress: { completed: job.sourceIds.length, total: job.sourceIds.length } });
        log.info('wiki_compile_no_changes', { jobId, sources: job.sourceIds.length, ms });
        return { job, proposalId: null, dropped: [], model, durationMs: ms };
      }

      await writeProposalRecord(this.store.root, pendingProposalRecord(normalized.proposal, job.id));
      job = await advanceJob(this.jobs, jobId, 'awaiting_review', { proposalId: normalized.proposal.id });
      log.info('wiki_proposal_filed', { jobId, proposalId: normalized.proposal.id, ops: normalized.proposal.operations.length, dropped: normalized.dropped.length });

      let report: ProposalReport | undefined;
      if (opts.autoAccept) {
        const accepted = await this.accept(normalized.proposal.id, 'system');
        report = accepted.report;
        job = (await this.jobs.read(jobId)) ?? job;
      }
      return { job, proposalId: normalized.proposal.id, dropped: normalized.dropped, report, model, durationMs: ms };
    } catch (error) {
      job = await advanceJob(this.jobs, jobId, 'failed', { error: error instanceof Error ? error.message.slice(0, 500) : 'Compile failed.' }).catch(() => job);
      log.error('wiki_compile_failed', { jobId, ...errorFields(error) });
      throw error;
    }
  }

  /** The model call, wrapped so the caller sees the draft plus bookkeeping. */
  private async propose(ctx: KeeperContext): Promise<{ object: KeeperDraft; ms: number; modelLabel: string }> {
    const settings = await this.deps.settings.get();
    const resolved = resolveModel(settings, 'brain', { think: true });
    const started = Date.now();
    const object = await this.proposeFn(ctx.prompt);
    return { object, ms: Date.now() - started, modelLabel: resolved.label };
  }

  private async jobSources(job: WikiJob): Promise<SourceRecord[]> {
    const records: SourceRecord[] = [];
    for (const id of job.sourceIds) {
      const record = await this.store.readSource(id);
      if (record) records.push(record);
      else log.warn('wiki_compile_source_missing', { jobId: job.id, sourceId: id });
    }
    return records;
  }

  /**
   * Reads the text each source's extraction produced — the frozen file first, and for
   * records written before extraction text was persisted, a re-run of the deterministic
   * readers. Vision sources without frozen text yield nothing rather than a second model call.
   */
  private async readBlobs(records: SourceRecord[]): Promise<SourceBlob[]> {
    const blobs: SourceBlob[] = [];
    for (const record of records) {
      let text = await this.store.readExtractionText(record.id);
      // Records filed before extraction text was persisted re-run the deterministic readers;
      // vision extractions have no deterministic re-run and stay empty rather than guessing.
      if (text === null) text = await this.extractNow(record);
      blobs.push({ record, text: text ?? '' });
    }
    return blobs;
  }

  private async extractNow(record: SourceRecord): Promise<string | null> {
    try {
      const bytes = await this.store.readSourceBytes(record.id, record.revision);
      if (!bytes) return null;
      if (record.mediaType === 'application/pdf') {
        const reader = await openPdf(bytes, this.deps.limits ?? {});
        try {
          const outcome = await extractPdf(bytes, reader, this.deps.limits ?? {});
          return outcome.ok ? outcome.result.text : null;
        } finally {
          await reader.close().catch(() => {});
        }
      }
      if (record.mediaType.startsWith('text/') || record.mediaType === 'application/json') {
        const outcome = extractText(new Uint8Array(bytes), this.deps.limits ?? {});
        return outcome.ok ? outcome.result.text : null;
      }
      return null;
    } catch (error) {
      log.warn('wiki_compile_reextract_failed', { sourceId: record.id, ...errorFields(error) });
      return null;
    }
  }

  async listProposals(): Promise<ProposalList> {
    const records = await listProposalRecords(this.store.root);
    return ProposalListSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      proposals: records,
      pending: records.filter((record) => record.state === 'pending').length,
    });
  }

  async getProposal(id: string): Promise<WikiProposalRecord | null> {
    return readProposalRecord(this.store.root, id);
  }

  /**
   * Applies an accepted proposal through the journaled path. Stale proposals (the vault
   * moved since the draft was prepared) are refused by applyProposal's revision check.
   */
  async accept(id: string, decidedBy: 'student' | 'system' = 'student'): Promise<{ record: WikiProposalRecord; report: ProposalReport }> {
    const record = await readProposalRecord(this.store.root, id);
    if (!record) throw new JobConflictError(`Proposal ${id} does not exist.`);
    if (record.state !== 'pending') throw new ProposalStateError(`Proposal ${id} was already ${record.state}.`);
    const report = await this.store.applyProposal(record.proposal);
    const decided = await decideProposal(this.store.root, record, 'accepted', decidedBy);
    const job = record.jobId ? await this.jobs.read(record.jobId) : null;
    if (job && job.stage === 'awaiting_review') {
      await advanceJob(this.jobs, job.id, 'committed', { progress: { completed: job.sourceIds.length, total: job.sourceIds.length } });
    }
    log.info('wiki_proposal_accepted', { proposalId: id, jobId: record.jobId, pages: report.pages.length });
    return { record: decided, report };
  }

  /** A rejected proposal changes no pages — only the record and the job move. */
  async reject(id: string, note?: string): Promise<WikiProposalRecord> {
    const record = await readProposalRecord(this.store.root, id);
    if (!record) throw new JobConflictError(`Proposal ${id} does not exist.`);
    if (record.state !== 'pending') throw new ProposalStateError(`Proposal ${id} was already ${record.state}.`);
    const decided = await decideProposal(this.store.root, record, 'rejected', 'student', note);
    const job = record.jobId ? await this.jobs.read(record.jobId) : null;
    if (job && job.stage === 'awaiting_review') {
      await advanceJob(this.jobs, job.id, 'cancelled');
    }
    log.info('wiki_proposal_rejected', { proposalId: id, jobId: record.jobId });
    return decided;
  }

  /**
   * What a pending proposal would do if accepted now — computed against pages read fresh
   * from disk, so the review screen shows the truth rather than a remembered plan.
   */
  async preview(id: string): Promise<{ record: WikiProposalRecord; pages: { id: string; kind: string; change: string; title: string; summaryBefore?: string; summaryAfter: string }[]; conflicts: string[] } | null> {
    const record = await readProposalRecord(this.store.root, id);
    if (!record) return null;
    const manifest = new Map<string, PageSnapshot | null>();
    for (const op of record.proposal.operations) {
      const idOf = op.op === 'upsert_page' ? op.page.id : op.fromPageId;
      if (!manifest.has(idOf)) manifest.set(idOf, await this.store.readPage(idOf));
    }
    const plan = planProposal(record.proposal, manifest, new Date().toISOString());
    const pages = [...plan.plans.values()].map((p) => ({
      id: p.content.metadata.id,
      kind: p.content.metadata.kind as string,
      change: p.created ? 'created' : p.changed ? 'updated' : 'unchanged',
      title: p.content.metadata.title,
      summaryBefore: p.snapshot?.metadata?.summary ?? p.snapshot?.legacy?.sections.in_my_words?.slice(0, 200) ?? undefined,
      summaryAfter: p.content.metadata.summary,
    }));
    const conflicts = plan.conflicts.map((conflict) => `${conflict.id}: ${conflict.reason}`);
    return { record, pages, conflicts };
  }
}

export { JobConflictError, JobStateError, VaultConflictError };
