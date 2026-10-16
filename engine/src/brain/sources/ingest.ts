import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  JobListSchema,
  SourceRecordSchema,
  SourceSummarySchema,
  type JobList,
  type ProfileIdentity,
  type SourceRecord,
  type SourceSummary,
  type TeacherId,
} from '@sef/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorFields, log } from '../../config';
import { extractPdf, extractText, sha256, type ExtractionMethod, type ExtractionResult } from './extract';
import { assertJobCapacity, advanceJob, cancelJob, createJob, jobStore, JobConflictError, JobStateError, listProfileJobs, retryJob } from './jobs';
import { checkBytes, countChars, sanitiseTitle, sliceChars, titleIsSafe, INGEST_LIMITS, type Limits } from './limits';
import { openPdf, PdfParseError } from './pdf';
import type { WikiStore } from '../wiki-store';

/**
 * Source ingestion: the student hands over bytes, the engine keeps them, and only then reads
 * anything out of them. The original is stored before extraction starts, so a failure
 * mid-read never costs the material and a retry re-reads the same bytes.
 */

export class SourceRejection extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: ContentfulStatusCode,
  ) {
    super(message);
  }
}

export type IngestKind = 'note' | 'document' | 'image' | 'session';

/** The committed transcript range a session source covers — the checkpoint written with it. */
export interface SessionRef {
  sessionId: string;
  teacher: TeacherId;
  firstTurn: number;
  lastTurn: number;
}

export interface IngestInput {
  kind: IngestKind;
  title: string;
  mediaType: string;
  bytes: Uint8Array;
  /** Required for kind 'session'; ignored otherwise. */
  session?: SessionRef;
  /**
   * A reading the caller already made (e.g. the vision transcription shown to the student).
   * Recorded as this source's extraction so the compiler never pays for the same read twice.
   */
  extraction?: { method: ExtractionMethod; text: string };
}

export interface IngestResult {
  source: SourceSummary;
  extraction: ExtractionResult | null;
  jobId: string;
  reused: boolean;
}

const newSourceId = (): string => `src_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

const ORIGIN: Record<IngestKind, 'student' | 'external'> = {
  note: 'student',
  document: 'external',
  image: 'student',
  session: 'student',
};

export class SourceIngestor {
  private readonly jobs;

  constructor(
    private readonly store: WikiStore,
    private readonly profile: () => Promise<ProfileIdentity>,
  ) {
    // Jobs live under the vault's own .meta/jobs — the same place WikiStore.readJob looks.
    this.jobs = jobStore(store.root);
  }

  /**
   * Validates, stores, then extracts — in that order. Every rejection happens before the
   * bytes touch disk, so a refused upload leaves nothing behind.
   */
  async ingest(input: IngestInput, limits: Limits = {}): Promise<IngestResult> {
    if (!titleIsSafe(input.title)) throw new SourceRejection('That title cannot be used.', 'unsafe_title', 400);
    const rejection = checkBytes(input.bytes, limits);
    if (rejection) throw new SourceRejection(rejection.message, rejection.code, rejection.code === 'empty' ? 400 : 413);

    const identity = await this.profile();
    const { active } = await listProfileJobs(this.jobs, identity);
    assertJobCapacity(active, limits);

    if (input.kind === 'session' && !input.session) {
      throw new SourceRejection('A session source must name the session and turns it covers.', 'missing_session_ref', 400);
    }
    const record = SourceRecordSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      id: newSourceId(),
      profile: identity,
      revision: 'r1',
      kind: input.kind,
      origin: ORIGIN[input.kind],
      title: sanitiseTitle(input.title),
      createdAt: new Date().toISOString(),
      mediaType: input.mediaType,
      sha256: sha256(input.bytes),
      bytes: input.bytes.byteLength,
      attribution: {},
      extractions: [],
      ...(input.kind === 'session' ? { session: input.session } : {}),
    });

    // The original is durable before anything is read out of it.
    const { record: storedAt, alreadyPresent } = await this.store.putSource(record, input.bytes);
    let stored = storedAt;
    log.info('source_stored', { sourceId: stored.id, kind: stored.kind, bytes: stored.bytes, alreadyPresent });

    const extraction = input.extraction ? this.adopted(input.extraction, input.bytes, limits) : await this.extract(stored, input.bytes, limits);
    // The extraction pass is part of the record: without it a later listing cannot say
    // whether the source ever produced text. The text itself is frozen beside the record
    // so the compiler reads back the same words rather than re-running the reader.
    if (extraction) {
      const chars = countChars(extraction.text);
      await this.store.recordExtraction(
        stored.id,
        { method: extraction.method, sha256: extraction.sha256, chars, partial: extraction.partial },
        extraction.text || undefined,
      );
      stored = { ...stored, extractions: [...stored.extractions, { revision: stored.revision, method: extraction.method, sha256: extraction.sha256, createdAt: new Date().toISOString(), chars, partial: extraction.partial }] };
    }
    const job = await this.track(stored.id, limits, identity);

    return {
      source: this.summaryOf(stored, extraction),
      extraction,
      jobId: job.id,
      reused: alreadyPresent || job.reused,
    };
  }

  /** The method a source would have used — reported even when no text was produced. */
  private intendedMethod(record: SourceRecord): ExtractionResult['method'] {
    if (record.mediaType.startsWith('application/pdf')) return 'pdf';
    if (record.mediaType.startsWith('image/')) return 'vision';
    return 'text';
  }

  /**
   * Wraps a caller-provided reading with the same limits an internal pass would get: the
   * text is counted and capped the same way, and the hash is of the source bytes, matching
   * what extract() records.
   */
  private adopted(provided: { method: ExtractionMethod; text: string }, bytes: Uint8Array, limits: Limits): ExtractionResult {
    const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
    const partial = countChars(provided.text) > maxChars;
    return {
      method: provided.method,
      text: sliceChars(provided.text, maxChars),
      sha256: sha256(bytes),
      partial,
      ...(partial ? { note: `Only the first ${maxChars.toLocaleString('en-GB')} characters of the reading were kept.` } : {}),
    };
  }

  /** Reads the source. A failure is reported in the result, never thrown: the original is safe. */
  private async extract(record: SourceRecord, bytes: Uint8Array, limits: Limits): Promise<ExtractionResult | null> {
    const method = this.intendedMethod(record);
    try {
      if (method === 'pdf') {
        const reader = await openPdf(bytes, limits);
        try {
          const outcome = await extractPdf(bytes, reader, limits);
          if (!outcome.ok) return this.readFailure(record, outcome.rejection.message);
          return outcome.result;
        } finally {
          await reader.close().catch(() => {});
        }
      }
      if (method === 'vision') {
        // Local vision is not wired yet. Say so rather than inventing a reading.
        return this.readFailure(record, 'No text has been read from this image yet.');
      }
      const outcome = extractText(bytes, limits);
      return outcome.ok ? outcome.result : this.readFailure(record, outcome.rejection.message);
    } catch (error) {
      // A bug in the extractor is not a "could not read" — keep it visible in the log so a
      // broken reader is not indistinguishable from a corrupt file.
      if (!(error instanceof PdfParseError)) {
        log.error('source_extraction_unexpected', { sourceId: record.id, mediaType: record.mediaType, ...errorFields(error) });
      }
      const message = error instanceof PdfParseError ? error.message : 'That source could not be read here.';
      return this.readFailure(record, message);
    }
  }

  /** An unreadable source keeps its bytes and reports why, rather than looking intact. */
  private readFailure(record: SourceRecord, note: string): ExtractionResult {
    log.warn('source_extraction_failed', { sourceId: record.id, mediaType: record.mediaType, note });
    return { method: this.intendedMethod(record), text: '', sha256: record.sha256, partial: true, note };
  }

  /**
   * `extraction` is the just-run pass when ingest calls this; `list()` passes null and the
   * answer comes from the record's own ledger instead, so the two paths agree.
   */
  private summaryOf(record: SourceRecord, extraction: ExtractionResult | null): SourceSummary {
    const ledger = record.extractions.at(-1);
    const last = extraction;
    return SourceSummarySchema.parse({
      id: record.id,
      revision: record.revision,
      title: record.title,
      kind: record.kind,
      mediaType: record.mediaType,
      bytes: record.bytes,
      sha256: record.sha256,
      extracted: last ? last.text !== '' : (ledger?.chars ?? 0) > 0,
      partial: last?.partial ?? ledger?.partial ?? false,
      ...(last?.note ? { note: last.note } : {}),
      capturedAt: record.createdAt,
    });
  }

  /** Joins the source to a durable job. Re-ingesting the same material reuses the live job. */
  private async track(sourceId: string, limits: Limits, identity: ProfileIdentity): Promise<{ id: string; reused: boolean }> {
    const { job, reused } = await createJob(
      this.jobs,
      { profile: identity, sourceIds: [sourceId], now: new Date() },
      limits,
    );
    if (job.stage === 'queued') {
      // A reused job is only ever queued if the first attempt died between create and
      // advance; the extraction above is this attempt's, so the resume is honest. The
      // total is the job's own source count, not a hard-coded one.
      await advanceJob(this.jobs, job.id, 'extracting', { progress: { completed: 1, total: job.sourceIds.length } });
    }
    return { id: job.id, reused };
  }

  async list(): Promise<JobList> {
    const identity = await this.profile();
    const { jobs, active } = await listProfileJobs(this.jobs, identity);
    const records = Object.values(await this.store.listSources()).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    return JobListSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      jobs,
      // Summaries only: this endpoint never returns source bodies.
      sources: records.map((record) => this.summaryOf(record, null)),
      activeJobs: active,
    });
  }

  /**
   * Belt-and-suspenders over the per-profile store: the jobs directory only holds this
   * profile's jobs today, but the ownership rule is stated here so it survives any store
   * that ever becomes shared. A job that is not this profile's answers 404, not 403 —
   * its existence is not another profile's business.
   */
  private async assertOwns(id: string): Promise<void> {
    const job = await this.jobs.read(id);
    const identity = await this.profile();
    if (!job || job.profile.studentId !== identity.studentId) {
      throw new JobConflictError(`Job ${id} does not exist.`);
    }
  }

  async cancel(id: string): Promise<void> {
    await this.assertOwns(id);
    await cancelJob(this.jobs, id);
  }

  async retry(id: string): Promise<void> {
    await this.assertOwns(id);
    await retryJob(this.jobs, id);
  }
}

export { JobConflictError, JobStateError };
