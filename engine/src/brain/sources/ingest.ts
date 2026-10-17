import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  JobListSchema,
  SourceRecordSchema,
  SourceSummarySchema,
  type JobList,
  type ProfileIdentity,
  type SourceLink,
  type SourceRecord,
  type SourceSummary,
  type TeacherId,
  type WikiJob,
} from '@sef/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorFields, log } from '../../config';
import { AudioTranscribeError, type AudioProbe, type AudioTranscription } from '../../media/audio';
import { extractPdf, extractText, recordAudioTranscript, recordStudentCorrection, sha256, type ExtractionMethod, type ExtractionResult } from './extract';
import { assertJobCapacity, advanceJob, cancelJob, createJob, jobStore, JobConflictError, JobStateError, listProfileJobs, retryJob } from './jobs';
import { checkAudioDuration, checkMediaType, checkSourceBytes, countChars, sanitiseTitle, sliceChars, titleIsSafe, INGEST_LIMITS, type Limits } from './limits';
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

export type IngestKind = 'note' | 'document' | 'image' | 'audio' | 'video' | 'session' | 'answer' | 'peer';

/** What the audio lane must answer — the recording's length up front, its transcript on read. */
export interface AudioReader {
  probe(bytes: Uint8Array, mediaType: string): Promise<AudioProbe>;
  transcribe(bytes: Uint8Array, mediaType: string, opts?: { seconds?: number; maxSeconds?: number }): Promise<AudioTranscription>;
}

/** The committed transcript range a session source covers — the checkpoint written with it. */
export interface SessionRef {
  sessionId: string;
  teacher: TeacherId;
  firstTurn: number;
  lastTurn: number;
}

/** The published share a peer source came from — the provenance the vault keeps forever. */
export interface PeerShareRef {
  id: string;
  revision: string;
  senderId: string;
  cohortId: string;
}

export interface IngestInput {
  kind: IngestKind;
  title: string;
  mediaType: string;
  bytes: Uint8Array;
  /** Required for kinds 'session' and 'answer'; ignored otherwise. */
  session?: SessionRef;
  /** Required for kind 'peer'; carries the share attribution verbatim. */
  share?: PeerShareRef;
  /** Required for kind 'video'; keeps where the recording was fetched from forever. */
  link?: SourceLink;
  /**
   * Who the student says wrote this. Kinds restrict the choice: a note is always the
   * student's own words, a document always external, an answer always a model's;
   * only an image can be either of the first two.
   */
  origin?: 'student' | 'external' | 'model';
  /** Who made it and where it came from, when the student knows. */
  attribution?: { creator?: string; url?: string };
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

const ORIGIN: Record<IngestKind, 'student' | 'external' | 'peer' | 'model'> = {
  note: 'student',
  document: 'external',
  image: 'student',
  audio: 'student',
  video: 'external',
  session: 'student',
  answer: 'model',
  peer: 'peer',
};

/** Which provenance claims each kind will carry — the record schema refuses the rest. */
const ALLOWED_ORIGIN: Record<IngestKind, ReadonlyArray<'student' | 'external' | 'peer' | 'model'>> = {
  note: ['student'],
  document: ['external'],
  image: ['student', 'external'],
  audio: ['student', 'external'],
  video: ['external'],
  session: ['student'],
  answer: ['model'],
  peer: ['peer'],
};

export class SourceIngestor {
  private readonly jobs;

  constructor(
    private readonly store: WikiStore,
    private readonly profile: () => Promise<ProfileIdentity>,
    private readonly audio?: AudioReader,
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
    const mediaRejection = checkMediaType(input.mediaType);
    if (mediaRejection) throw new SourceRejection(mediaRejection.message, mediaRejection.code, 415);
    const rejection = checkSourceBytes(input.bytes, input.mediaType, limits);
    if (rejection) throw new SourceRejection(rejection.message, rejection.code, rejection.code === 'empty' ? 400 : 413);

    // The audio family pins the kind both ways: an audio mime filed as a document would
    // transcribe without the duration probe, and an 'audio'/'video' kind over text would
    // probe bytes that were never a recording. A video's stored bytes *are* its audio
    // track, so both kinds accept the family.
    const isAudioMedia = input.mediaType.split(';')[0]!.trim().toLowerCase().startsWith('audio/');
    const isAudioKind = input.kind === 'audio' || input.kind === 'video';
    if (isAudioKind !== isAudioMedia) {
      throw new SourceRejection(`Audio bytes are filed as kind 'audio' or 'video' — a '${input.kind}' cannot declare ${input.mediaType}.`, 'kind_mismatch', 400);
    }

    const identity = await this.profile();
    const { active } = await listProfileJobs(this.jobs, identity);
    assertJobCapacity(active, limits);

    if ((input.kind === 'session' || input.kind === 'answer') && !input.session) {
      throw new SourceRejection(`A ${input.kind} source must name the session and turns it covers.`, 'missing_session_ref', 400);
    }
    if (input.kind === 'peer' && !input.share) {
      throw new SourceRejection('A peer source must name the share it came from.', 'missing_share_ref', 400);
    }
    if (input.kind === 'video' && !input.link) {
      throw new SourceRejection('A video source must carry the link it was fetched from.', 'missing_link_ref', 400);
    }
    const origin = input.origin ?? ORIGIN[input.kind];
    if (!ALLOWED_ORIGIN[input.kind].includes(origin)) {
      throw new SourceRejection(`A ${input.kind} cannot be filed as '${origin}' material.`, 'origin_mismatch', 400);
    }

    // Audio is probed before the bytes are stored: a recording too long to transcribe is a
    // named refusal, and one ffmpeg cannot parse is not an audio file at all. A video's
    // audio track probes exactly the same. With no transcriber wired the probe is skipped —
    // the stored source then reports why instead.
    let audioSeconds: number | undefined;
    if (isAudioMedia && this.audio) {
      try {
        const probe = await this.audio.probe(input.bytes, input.mediaType);
        audioSeconds = probe.seconds;
        if (Number.isFinite(audioSeconds)) {
          const duration = checkAudioDuration(audioSeconds, limits);
          if (duration) throw new SourceRejection(duration.message, duration.code, 413);
        }
      } catch (error) {
        if (error instanceof SourceRejection) throw error;
        if (error instanceof AudioTranscribeError) {
          throw new SourceRejection(error.message, error.code === 'ffmpeg_missing' ? 'ffmpeg_missing' : 'unsupported_media', error.code === 'ffmpeg_missing' ? 503 : 415);
        }
        throw error;
      }
    }
    const record = SourceRecordSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      id: newSourceId(),
      profile: identity,
      revision: 'r1',
      kind: input.kind,
      origin,
      title: sanitiseTitle(input.title),
      createdAt: new Date().toISOString(),
      mediaType: input.mediaType,
      sha256: sha256(input.bytes),
      bytes: input.bytes.byteLength,
      attribution: input.attribution ?? {},
      extractions: [],
      ...(input.kind === 'session' || input.kind === 'answer' ? { session: input.session } : {}),
      ...(input.kind === 'peer' ? { share: input.share } : {}),
      ...(input.kind === 'video' ? { link: input.link } : {}),
    });

    // The original is durable before anything is read out of it.
    const { record: storedAt, alreadyPresent } = await this.store.putSource(record, input.bytes);
    let stored = storedAt;
    log.info('source_stored', { sourceId: stored.id, kind: stored.kind, bytes: stored.bytes, alreadyPresent });

    const extraction = input.extraction ? this.adopted(input.extraction, input.bytes, limits) : await this.extract(stored, input.bytes, limits, audioSeconds);
    // The extraction pass is part of the record: without it a later listing cannot say
    // whether the source ever produced text. The text itself is frozen beside the record
    // so the compiler reads back the same words rather than re-running the reader.
    if (extraction) {
      const chars = countChars(extraction.text);
      await this.store.recordExtraction(
        stored.id,
        { method: extraction.method, sha256: extraction.sha256, chars, partial: extraction.partial, ...(extraction.note ? { note: extraction.note } : {}) },
        extraction.text || undefined,
      );
      stored = { ...stored, extractions: [...stored.extractions, { revision: stored.revision, method: extraction.method, sha256: extraction.sha256, createdAt: new Date().toISOString(), chars, partial: extraction.partial, ...(extraction.note ? { note: extraction.note } : {}) }] };
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
    if (record.mediaType.startsWith('audio/')) return 'audio';
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
  private async extract(record: SourceRecord, bytes: Uint8Array, limits: Limits, audioSeconds?: number): Promise<ExtractionResult | null> {
    const method = this.intendedMethod(record);
    try {
      if (method === 'audio') {
        if (!this.audio) {
          return this.readFailure(record, 'Audio transcription is not configured on this device.');
        }
        const transcript = await this.audio.transcribe(bytes, record.mediaType, {
          ...(audioSeconds !== undefined ? { seconds: audioSeconds } : {}),
          ...(limits.maxAudioSeconds !== undefined ? { maxSeconds: limits.maxAudioSeconds } : {}),
        });
        const outcome = recordAudioTranscript(bytes, transcript, limits);
        return outcome.ok ? outcome.result : this.readFailure(record, outcome.rejection.message);
      }
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
      if (!(error instanceof PdfParseError || error instanceof AudioTranscribeError)) {
        log.error('source_extraction_unexpected', { sourceId: record.id, mediaType: record.mediaType, ...errorFields(error) });
      }
      const message = error instanceof PdfParseError || error instanceof AudioTranscribeError ? error.message : 'That source could not be read here.';
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
    const stage = (await this.jobs.read(job.id))?.stage;
    if (stage === 'extracting') {
      // Extraction is done; the reading now waits for the student to check it before a
      // compile spends model time on words they have not seen.
      await advanceJob(this.jobs, job.id, 'awaiting_source_review');
    }
    return { id: job.id, reused };
  }

  async list(): Promise<JobList> {
    const identity = await this.profile();
    const { jobs, active } = await listProfileJobs(this.jobs, identity);
    const records = Object.values(await this.store.listSources())
      // The vault root is already per-profile; the filter is stated anyway so a store
      // that ever becomes shared cannot leak another student's catalogue.
      .filter((record) => record.profile.studentId === identity.studentId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return JobListSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      jobs,
      // Summaries only: this endpoint never returns source bodies.
      sources: records.map((record) => this.summaryOf(record, null)),
      activeJobs: active,
    });
  }

  /**
   * The full retained record for one source: its latest extraction text (what a compile
   * would read) and the newest job covering it. A foreign source answers null — its
   * existence is not another profile's business.
   */
  async detail(id: string): Promise<{
    record: SourceRecord;
    extraction: { method: ExtractionMethod; text: string; partial: boolean; note?: string; at: string } | null;
    job: WikiJob | null;
  } | null> {
    const [record, identity] = await Promise.all([this.store.readSource(id), this.profile()]);
    if (!record || record.profile.studentId !== identity.studentId) return null;
    const latest = record.extractions.at(-1);
    const text = latest ? await this.store.readExtractionText(record.id) : null;
    const extraction = latest
      ? { method: latest.method, text: text ?? '', partial: latest.partial ?? false, ...(latest.note ? { note: latest.note } : {}), at: latest.createdAt }
      : null;
    const { jobs } = await listProfileJobs(this.jobs, identity);
    const job = jobs.find((candidate) => candidate.sourceIds.includes(record.id)) ?? null;
    return { record, extraction, job };
  }

  /**
   * The student rewrites what the reader produced — fixing OCR, a transcription, a paste.
   * The original bytes never change; the correction is appended to the extraction ledger
   * as its own pass, so a compile reads it and a later re-read can still be told apart.
   */
  /** The original bytes for the student's own eyes — e.g. the photo beside its transcription. */
  async rawBytes(id: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
    const [record, identity] = await Promise.all([this.store.readSource(id), this.profile()]);
    if (!record || record.profile.studentId !== identity.studentId) return null;
    const bytes = await this.store.readSourceBytes(record.id);
    return bytes ? { bytes: new Uint8Array(bytes), mediaType: record.mediaType } : null;
  }

  async correct(id: string, text: string, limits: Limits = {}) {
    const [record, identity] = await Promise.all([this.store.readSource(id), this.profile()]);
    if (!record || record.profile.studentId !== identity.studentId) {
      throw new SourceRejection('Source not found.', 'not_found', 404);
    }
    if (!text.trim()) {
      throw new SourceRejection('There is no corrected text to keep.', 'empty', 400);
    }
    const maxChars = limits.maxExtractedChars ?? INGEST_LIMITS.maxExtractedChars;
    if (countChars(text) > maxChars) {
      throw new SourceRejection(`That correction is longer than the ${maxChars.toLocaleString('en-GB')} character limit.`, 'too_large', 413);
    }
    const bytes = await this.store.readSourceBytes(record.id);
    if (!bytes) {
      throw new SourceRejection('The original bytes are missing; this source cannot be corrected.', 'missing_source', 409);
    }
    const outcome = recordStudentCorrection(bytes, text, limits);
    if (!outcome.ok) {
      throw new SourceRejection(outcome.rejection.message, outcome.rejection.code, 400);
    }
    await this.store.recordExtraction(
      record.id,
      { method: 'student_correction', sha256: outcome.result.sha256, chars: countChars(outcome.result.text), partial: outcome.result.partial, ...(outcome.result.note ? { note: outcome.result.note } : {}) },
      outcome.result.text || undefined,
    );
    log.info('source_correction_recorded', { sourceId: record.id, chars: countChars(outcome.result.text) });
    return this.detail(record.id);
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
