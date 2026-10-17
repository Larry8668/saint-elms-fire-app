import {
  CONTRACT_VERSION,
  PublishedShareSchema,
  ShareFeedPageSchema,
  SharedAttachmentSchema,
  type OwnShare,
  type OwnSharesResponse,
  type PeerFeedResponse,
  type PublishShareRequest,
  type PublishShareResult,
  type PublishedShare,
  type ShareDraftRequest,
  type ShareDraftResponse,
  type ShareImportResult,
  type ShareablePage,
  type ShareablePageList,
  type SharePayload,
  type ShareScreening,
  type SharedAttachment,
  type SourceRecord,
} from '@sef/shared';
import type { WikiCompiler } from '../brain/compiler/compile';
import { jobStore } from '../brain/sources/jobs';
import type { SourceIngestor } from '../brain/sources/ingest';
import { legacyPageSummary } from '../brain/wiki-page-format';
import type { PageSnapshot, WikiStore } from '../brain/wiki-store';
import { errorFields, log } from '../config';
import { UniHttpError, UniUnreachableError, uniRequest } from '../uni/client';
import { buildSharePayload, peerSourceDocument, shareRequest, type ShareSourcePage } from './payload';
import { screeningNote, type Screener } from './screen';
import type { PeerShareStore } from './store';

/** A refused or failed share call. `code` is the uni's own error code where one exists. */
export class PeerShareError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** What the service needs from the network. Injectable so tests never touch a socket. */
export type ShareCall = (
  baseUrl: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; token: string },
) => Promise<{ status: number; data: unknown }>;

const defaultCall: ShareCall = async (baseUrl, path, init) => {
  try {
    return await uniRequest(baseUrl, path, init);
  } catch (error) {
    if (error instanceof UniUnreachableError) {
      throw new PeerShareError('unreachable', 'The university server cannot be reached right now.');
    }
    if (error instanceof UniHttpError) {
      const code = (error.body as { error?: string } | null)?.error ?? `http_${error.status}`;
      throw new PeerShareError(code, `The university refused: ${code}.`, error.status);
    }
    throw error;
  }
};

export interface PeerShareDeps {
  wiki: WikiStore;
  sources: SourceIngestor;
  compiler: WikiCompiler;
  store: PeerShareStore;
  uniUrl: () => Promise<string>;
  uniToken: () => Promise<string | undefined>;
  /** The profile's programme and cohort, for stamping and disclosure. */
  enrolment: () => Promise<{ programmeId: string; cohortId: string | null }>;
  call?: ShareCall;
  /**
   * The on-device share screen. Advisory: absent or failing screeners never block a
   * publish or an import — the result just says `unavailable`.
   */
  screen?: Screener;
}

/** The uni only accepts these as attachment descriptors — anything else is refused here first. */
const ATTACHABLE_MEDIA = new Set<string>(SharedAttachmentSchema.shape.mediaType.options);
/** Attachment descriptors come from the student's frozen sources — never sessions, answers or peer material. */
const ATTACHABLE_KINDS = new Set<SourceRecord['kind']>(['note', 'document', 'image']);
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Cohort sharing for one profile: publish drafts, the cohort feed, own items and
 * peer imports. Everything network-facing goes through one call seam, so an
 * unreachable uni degrades to honest empty states instead of fabricated content.
 */
export class PeerShareService {
  private readonly call: ShareCall;

  constructor(private readonly deps: PeerShareDeps) {
    this.call = deps.call ?? defaultCall;
  }

  private async uni(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}) {
    const token = await this.deps.uniToken();
    if (!token) {
      throw new PeerShareError('no_session', 'This profile has no university session. Sign in while online to use sharing.');
    }
    return this.call(await this.deps.uniUrl(), path, { ...init, token });
  }

  private async cohort(): Promise<string | null> {
    try {
      return (await this.deps.enrolment()).cohortId;
    } catch {
      return null;
    }
  }

  /** The cohort feed. A failure is a state, never an exception: offline and unsigned-in are real answers. */
  async feed(query: { cursor?: string; limit?: number } = {}): Promise<PeerFeedResponse> {
    const base = { schemaVersion: CONTRACT_VERSION, cohortId: await this.cohort(), items: [], nextCursor: null };
    let items: PublishedShare[];
    let nextCursor: string | null;
    try {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit) params.set('limit', String(query.limit));
      const qs = params.toString();
      const { data } = await this.uni(`/v1/shares${qs ? `?${qs}` : ''}`);
      const parsed = ShareFeedPageSchema.safeParse(data);
      if (!parsed.success) {
        log.warn('peer_feed_contract_mismatch', { issues: parsed.error.issues.length });
        return { ...base, state: 'unavailable', detail: 'The university sent a feed this app cannot read.' };
      }
      items = parsed.data.items;
      nextCursor = parsed.data.nextCursor;
    } catch (error) {
      if (error instanceof PeerShareError) return { ...base, ...this.feedFailure(error) };
      throw error;
    }

    const ledger = await this.deps.store.read();
    const imports = await this.importIndex();
    const ignored = new Set(ledger.ignored);
    const annotated = items
      // The feed is published-only; filter defensively in case that ever stops being true.
      .filter((item) => item.state === 'published')
      .map((item) => ({
        ...item,
        mine: Boolean(ledger.published[item.id]),
        import: imports.get(`${item.id}|${item.revision}`) ?? null,
        ignored: ignored.has(item.id),
      }));
    return { ...base, cohortId: annotated[0]?.cohortId ?? base.cohortId, state: 'ok', detail: null, items: annotated, nextCursor };
  }

  private feedFailure(error: PeerShareError): { state: PeerFeedResponse['state']; detail: string } {
    switch (error.code) {
      case 'no_session':
      case 'unauthenticated':
        return { state: 'auth_required', detail: 'Sharing needs a live university session. Sign in while online, then try again.' };
      case 'unreachable':
        return { state: 'offline', detail: 'The university is unreachable. The peer feed needs the network — nothing here is cached.' };
      case 'unapproved':
        return { state: 'unavailable', detail: 'Your enrolment is not approved, so the cohort feed is not open to you.' };
      default:
        return { state: 'unavailable', detail: error.message };
    }
  }

  /**
   * The author's own items, including withdrawn ones. The feed cannot show these —
   * it lists only live shares — so the local ledger is the memory and the uni is
   * consulted per item when reachable. Offline shows the last confirmed state.
   */
  async mine(): Promise<OwnSharesResponse> {
    const ledger = await this.deps.store.read();
    const entries = Object.values(ledger.published).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const items: OwnShare[] = [];
    let reachable = false;
    for (const entry of entries) {
      let live: PublishedShare | null = null;
      try {
        const { data } = await this.uni(`/v1/shares/${entry.id}`);
        const parsed = PublishedShareSchema.safeParse(data);
        if (parsed.success) {
          live = parsed.data;
          reachable = true;
        }
      } catch (error) {
        if (!(error instanceof PeerShareError)) throw error;
        // Unreachable, refused, or no session: the stored state is the honest last word.
      }
      if (live) {
        if (live.state !== entry.state || live.revision !== entry.revision) {
          await this.deps.store.updateState(entry.id, live.state, live.revision);
        }
        items.push({ ...live, freshness: 'live' });
      } else {
        items.push({
          schemaVersion: CONTRACT_VERSION,
          id: entry.id,
          revision: entry.revision,
          senderId: entry.senderId,
          senderName: entry.senderName,
          programmeId: entry.programmeId,
          cohortId: entry.cohortId,
          createdAt: entry.createdAt,
          state: entry.state,
          payload: entry.payload,
          freshness: 'stored',
        });
      }
    }
    return { schemaVersion: CONTRACT_VERSION, reachable, items };
  }

  /** The pages the student may publish, across every wiki kind. */
  async pages(): Promise<ShareablePageList> {
    const items: ShareablePage[] = [];
    for (const snapshot of await this.deps.wiki.listPages()) {
      if (snapshot.format === 2 && snapshot.metadata) {
        items.push({ id: snapshot.id, kind: snapshot.metadata.kind, title: snapshot.metadata.title, summary: snapshot.metadata.summary, revision: snapshot.revision });
      } else if (snapshot.format === 1 && snapshot.legacy) {
        items.push({ id: snapshot.id, kind: 'concept', title: snapshot.legacy.concept || snapshot.legacy.key, summary: legacyPageSummary(snapshot.legacy), revision: snapshot.revision });
      }
    }
    items.sort((a, b) => a.title.localeCompare(b.title));
    return { schemaVersion: CONTRACT_VERSION, items };
  }

  /**
   * Builds the draft the student previews. The returned `request` is the exact body
   * that later goes on the wire — nothing is assembled again at publish time.
   */
  async prepare(input: ShareDraftRequest): Promise<ShareDraftResponse> {
    const page = shareablePage(await this.deps.wiki.readPage(input.pageId));
    if (!page) throw new PeerShareError('unshareable_page', 'That page is not in a format this app can share.', 400);
    const attachments = await this.resolveAttachments(input.attachmentSourceIds ?? []);
    const { payload, excluded } = buildSharePayload(page, attachments);
    const { programmeId, cohortId } = await this.deps.enrolment();
    // The author sees the same screen an importer would — advisory, so publish stays free.
    const screening = await this.screenPayload(payload);
    return { schemaVersion: CONTRACT_VERSION, request: shareRequest(input.pageId, programmeId, payload), cohortId, excluded, screening };
  }

  private async resolveAttachments(sourceIds: string[]): Promise<SharedAttachment[]> {
    const attachments: SharedAttachment[] = [];
    for (const id of sourceIds) {
      const record = await this.deps.wiki.readSource(id);
      if (!record) throw new PeerShareError('not_found', `Source ${id} does not exist.`, 404);
      if (!ATTACHABLE_KINDS.has(record.kind)) {
        throw new PeerShareError('attachment_type', `A ${record.kind} source cannot be shared as an attachment.`, 400);
      }
      if (!ATTACHABLE_MEDIA.has(record.mediaType)) {
        throw new PeerShareError('attachment_type', `${record.mediaType} cannot be shared as an attachment.`, 400);
      }
      if (record.bytes > ATTACHMENT_MAX_BYTES) {
        throw new PeerShareError('attachment_too_large', `${record.title} is too large to attach.`, 400);
      }
      attachments.push({ id: record.id, name: record.title.slice(0, 200), mediaType: record.mediaType as SharedAttachment['mediaType'], sha256: record.sha256, bytes: record.bytes });
    }
    return attachments;
  }

  /** Relays the previewed request to the uni verbatim and records the result locally. */
  async publish(request: PublishShareRequest): Promise<PublishShareResult> {
    const { programmeId } = await this.deps.enrolment();
    if (request.programmeId !== programmeId) {
      throw new PeerShareError('programme_mismatch', 'That draft was prepared for a different programme.', 403);
    }
    const { status, data } = await this.uni('/v1/shares', { method: 'POST', body: request });
    const share = PublishedShareSchema.parse(data);
    await this.deps.store.recordPublished(share);
    log.info('peer_share_published', { shareId: share.id, cohortId: share.cohortId, replayed: status === 200 });
    return { schemaVersion: CONTRACT_VERSION, share, replayed: status === 200 };
  }

  /** The author's withdrawal. Stops future downloads; imported copies are never recalled. */
  async withdraw(shareId: string): Promise<PublishedShare> {
    const { data } = await this.uni(`/v1/shares/${encodeURIComponent(shareId)}/withdraw`, { method: 'POST' });
    const share = PublishedShareSchema.parse(data);
    await this.deps.store.updateState(share.id, share.state, share.revision);
    log.info('peer_share_withdrawn', { shareId: share.id });
    return share;
  }

  async ignore(shareId: string, ignored: boolean): Promise<void> {
    await this.deps.store.setIgnored(shareId, ignored);
  }

  /**
   * Imports a feed item as a peer-attributed source, then runs the same pipeline any
   * other source runs: freeze → compile → a proposal the student must still accept.
   * Peer material never touches mastery or the vault directly. A second import of the
   * same share+revision replays the first — no duplicate source, no duplicate job.
   */
  async importShare(shareId: string): Promise<ShareImportResult> {
    const { data } = await this.uni(`/v1/shares/${encodeURIComponent(shareId)}`);
    const share = PublishedShareSchema.parse(data);
    if (share.state !== 'published') {
      throw new PeerShareError('not_published', 'That share has been withdrawn and can no longer be imported.', 409);
    }

    const existing = (await this.importIndex()).get(`${share.id}|${share.revision}`);
    if (existing) {
      // A jobless source means an earlier import died between putSource and createJob;
      // '' would fail assertRecordId inside read, so report it as failed instead.
      const job = existing.jobId ? await jobStore(this.deps.wiki.root).read(existing.jobId) : null;
      return {
        schemaVersion: CONTRACT_VERSION,
        shareId: share.id,
        sourceId: existing.sourceId,
        jobId: existing.jobId,
        proposalId: job?.proposalId ?? null,
        stage: job?.stage ?? 'failed',
        reused: true,
      };
    }

    const screening = await this.screenPayload(share.payload);
    const document = peerSourceDocument(share);
    const bytes = new TextEncoder().encode(document);
    const ingested = await this.deps.sources.ingest({
      kind: 'peer',
      title: `Peer share: ${share.payload.title}`,
      mediaType: 'text/markdown',
      bytes,
      share: { id: share.id, revision: share.revision, senderId: share.senderId, cohortId: share.cohortId },
      // The screening verdict rides the extraction ledger — the source itself records it.
      extraction: { method: 'text', text: document, note: screeningNote(screening) },
    });
    // No autoAccept: importing a peer's words is not the student's review.
    const compiled = await this.deps.compiler.compileJob(ingested.jobId);
    log.info('peer_share_imported', { shareId: share.id, sourceId: ingested.source.id, jobId: ingested.jobId, stage: compiled.job.stage, screened: screening.status });
    return {
      schemaVersion: CONTRACT_VERSION,
      shareId: share.id,
      sourceId: ingested.source.id,
      jobId: ingested.jobId,
      proposalId: compiled.proposalId,
      stage: compiled.job.stage,
      reused: false,
      screening,
    };
  }

  /** Screen the payload text — never throws, so screening can never break a share flow. */
  private async screenPayload(payload: SharePayload): Promise<ShareScreening> {
    if (!this.deps.screen) return { status: 'unavailable', categories: [], model: '' };
    try {
      return await this.deps.screen.screen(payload);
    } catch (error) {
      // A screener that throws anyway is still only advisory.
      log.warn('peer_share_screen_threw', errorFields(error));
      return { status: 'unavailable', categories: [], model: '' };
    }
  }

  /** share.id|share.revision → the source (and job) an earlier import created. */
  private async importIndex(): Promise<Map<string, { sourceId: string; jobId: string }>> {
    const records = Object.values(await this.deps.wiki.listSources());
    const peers = records.filter((record): record is Extract<SourceRecord, { kind: 'peer' }> => record.kind === 'peer');
    if (!peers.length) return new Map();
    const jobs = await jobStore(this.deps.wiki.root).list();
    const index = new Map<string, { sourceId: string; jobId: string }>();
    for (const record of peers) {
      const job = jobs.filter((j) => j.sourceIds.includes(record.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      index.set(`${record.share.id}|${record.share.revision}`, { sourceId: record.id, jobId: job?.id ?? '' });
    }
    return index;
  }
}

function shareablePage(snapshot: PageSnapshot | null): ShareSourcePage | null {
  if (!snapshot) return null;
  if (snapshot.format === 2 && snapshot.metadata) {
    return { title: snapshot.metadata.title, kind: snapshot.metadata.kind, summary: snapshot.metadata.summary, body: snapshot.body };
  }
  if (snapshot.format === 1 && snapshot.legacy) {
    return { title: snapshot.legacy.concept || snapshot.legacy.key, kind: 'concept', summary: legacyPageSummary(snapshot.legacy), body: snapshot.body };
  }
  return null;
}
