import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CONTRACT_VERSION,
  LearningEventSchema,
  SourceRecordSchema,
  SourceTombstoneSchema,
  WikiProposalSchema,
  type BrainLogEntry,
  type LearningEvent,
  type PageRevisionContent,
  type PageRevisionList,
  type Revision,
  type SourceDependents,
  type SourceRecord,
  type SourceTombstone,
  type WikiJob,
  type WikiProposal,
} from '@sef/shared';
import { errorFields, log } from '../config';
import { readBytes, readJson, readText, writeFileAtomic, writeFileExclusive } from '../lib/fs';
import { sha256Hex } from '../lib/hash';
import { deriveGrowthEvents } from './growth';
import { renderIndex, type IndexEntry } from './index-format';
import { recentLogEntries, renderLogEntry } from './log-format';
import { ensureConventionsFile, readConventions, type ConventionsRead } from './schema-conventions';
import { VaultConflictError, VaultIntegrityError, VaultSchemaError, type VaultConflictDetail } from './vault-errors';
import { listJobs, readJob, writeJob } from './vault-jobs';
import { applyJournalSteps, beginJournal, completeJournal, pendingJournals, recoverJournals, type JournalStep, type RecoveryReport } from './vault-journal';
import { VaultLock, type VaultLockOptions } from './vault-lock';
import {
  HISTORY_DIRECTORY,
  INDEX_FILE,
  KIND_DIRECTORY,
  LOG_FILE,
  META_DIRECTORY,
  META_EVENTS_DIRECTORY,
  META_MANIFEST_FILE,
  META_SOURCES_DIRECTORY,
  META_TOMBSTONES_DIRECTORY,
  PAGE_KINDS,
  VAULT_DIRECTORIES,
  VAULT_LAYOUT_VERSION,
  assertRecordId,
  assertRelativeVaultPath,
  assertSafeRevision,
  historyRelativePath,
  isRawPath,
  pageIdFromFileName,
  pageRelativePath,
  rawRelativePath,
  vaultPath,
  type PageKind,
} from './vault-layout';
import {
  assertWritableManifest,
  emptyManifest,
  readManifest,
  type ManifestIntegrity,
  type VaultManifest,
  type VaultManifestPage,
  type VaultManifestSource,
} from './vault-manifest';
import { indexEntryOf, indexEntryOfContent, pageSnapshotFromContent, planProposal, planUpgrade, stamped, type PageChange, type PagePlan, type PageSnapshot } from './wiki-plan';
import { contentRevision, serializePageFile } from './wiki-page-format';

export type { PageChange, PageSnapshot } from './wiki-plan';

export interface WikiStoreOptions extends VaultLockOptions {
  /** Injectable clock, so a commit's timestamps are deterministic in tests. */
  now?: () => Date;
}

export interface ProposalReport {
  proposalId: string;
  committed: boolean;
  journalId: string | null;
  pages: PageChange[];
  logEntry: BrainLogEntry;
}

export interface VaultStatus {
  layout: number;
  manifestIntegrity: ManifestIntegrity;
  pages: number;
  sources: number;
  conventionsRevision: string;
  conventionsSource: ConventionsRead['source'];
  pendingCommits: number;
}

type ManifestPage = VaultManifestPage;
type ManifestSource = VaultManifestSource;

/**
 * The single authoritative writer for the vault. Reads always come from disk, so an edit made in
 * Obsidian (or by another tool) is seen rather than papered over by a cached map; writes take the
 * vault lock, record a write-ahead journal, and only then touch the files.
 */
export class WikiStore {
  readonly root: string;
  private readonly lock: VaultLock;
  private readonly now: () => Date;

  constructor(root: string, options: WikiStoreOptions = {}) {
    this.root = path.resolve(root);
    this.lock = new VaultLock(this.root, options);
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await Promise.all(VAULT_DIRECTORIES.map((directory) => mkdir(vaultPath(this.root, directory), { recursive: true })));
    await ensureConventionsFile(this.root);
    const at = this.now().toISOString();
    if ((await readText(vaultPath(this.root, INDEX_FILE))) === null) await writeFileAtomic(vaultPath(this.root, INDEX_FILE), renderIndex([], at));
    if ((await readText(vaultPath(this.root, LOG_FILE))) === null) await writeFileAtomic(vaultPath(this.root, LOG_FILE), '# Learning log\n\n');
    log.info('vault_initialised', { root: this.root, layout: VAULT_LAYOUT_VERSION });
  }

  /** Finishes any commit that was interrupted, then reports what it did. */
  async recover(): Promise<RecoveryReport> {
    return this.lock.run(() => recoverJournals(this.root, this.now().toISOString()));
  }

  /** The versioned conventions a job must be prepared against; a future compiler consumes these. */
  readConventions(): Promise<ConventionsRead> {
    return readConventions(this.root);
  }

  async status(): Promise<VaultStatus> {
    const [pages, sources, manifest, conventions, commits] = await Promise.all([
      this.listPages(),
      this.listSources(),
      readManifest(this.root),
      readConventions(this.root),
      pendingJournals(this.root),
    ]);
    return {
      layout: VAULT_LAYOUT_VERSION,
      manifestIntegrity: manifest.integrity,
      pages: pages.length,
      sources: Object.keys(sources).length,
      conventionsRevision: conventions.conventions.revision,
      conventionsSource: conventions.source,
      pendingCommits: commits.length,
    };
  }

  async readPage(id: string): Promise<PageSnapshot | null> {
    const safeId = assertRecordId(id, 'Page id');
    return this.findPage(safeId, (await readManifest(this.root)).manifest);
  }

  async listPages(): Promise<PageSnapshot[]> {
    return this.listPagesWith((await readManifest(this.root)).manifest);
  }

  async readIndex(): Promise<string | null> {
    return readText(vaultPath(this.root, INDEX_FILE));
  }

  async readLog(limit = 50): Promise<BrainLogEntry[]> {
    return recentLogEntries((await readText(vaultPath(this.root, LOG_FILE))) ?? '', limit);
  }

  async appendLog(entry: Omit<BrainLogEntry, 'at'>, at = this.now().toISOString()): Promise<void> {
    await this.lock.run(() => this.commit(`wiki.log:${entry.kind}`, [{ kind: 'append', path: LOG_FILE, content: renderLogEntry({ ...entry, at }) }]));
  }

  /** Applies a validated proposal, or refuses all of it. Nothing is written unless every page matches. */
  async applyProposal(proposal: WikiProposal): Promise<ProposalReport> {
    const value = WikiProposalSchema.parse(proposal);
    return this.lock.run(async () => {
      const conventions = await readConventions(this.root);
      if (value.conventionRevision !== conventions.conventions.revision) {
        throw new VaultConflictError('The vault conventions changed since this proposal was prepared; read SCHEMA.md again and prepare a new proposal.', [
          { id: value.id, expected: value.conventionRevision, found: conventions.conventions.revision, reason: 'conventions_changed' },
        ]);
      }
      const at = this.now().toISOString();
      const manifest = (await readManifest(this.root)).manifest;
      const existing = new Map<string, PageSnapshot | null>();
      for (const operation of value.operations) {
        const id = operation.op === 'upsert_page' ? operation.page.id : operation.fromPageId;
        if (existing.has(id)) continue;
        existing.set(id, await this.findPage(id, manifest));
      }
      const plan = planProposal(value, existing, at);
      if (plan.conflicts.length) throw new VaultConflictError(describeConflicts(plan.conflicts), plan.conflicts);
      // Growth events ride the same journal as the page writes: keyed by the revision they
      // commit, so a replayed proposal rewrites identical files and never duplicates them.
      const sources = new Map<string, SourceRecord>();
      for (const id of value.sourceIds) {
        const record = await this.readSource(id);
        if (record) sources.set(id, record);
      }
      const revisions = new Map([...plan.plans].map(([id, p]) => [id, contentRevision(p.content)]));
      const events = deriveGrowthEvents({ proposal: value, plans: plan.plans, sources, revisions, at });
      const result = await this.commitPlans(
        plan.plans,
        `wiki.proposal:${value.id}`,
        (changes) => ({
          at,
          kind: 'wiki',
          title: `Wiki update from proposal ${value.id}`,
          detail: describeChanges(changes),
        }),
        events.map((event) => ({ kind: 'write' as const, path: `${META_DIRECTORY}/${META_EVENTS_DIRECTORY}/${event.id}.json`, content: `${JSON.stringify(event, null, 2)}\n` })),
      );
      return {
        proposalId: value.id,
        committed: result.committed,
        journalId: result.journalId,
        pages: [...result.changes, ...plan.unchanged],
        logEntry: result.logEntry,
      };
    });
  }

  /** Adopts one page that is still in the earlier concept format, keeping its prose and provenance. */
  async upgradeLegacyPage(id: string): Promise<PageChange | null> {
    const safeId = assertRecordId(id, 'Page id');
    return this.lock.run(async () => {
      const manifest = (await readManifest(this.root)).manifest;
      const snapshot = await this.findPage(safeId, manifest);
      if (!snapshot) return null;
      if (snapshot.format === 2) {
        return { id: safeId, kind: snapshot.kind, change: 'unchanged' as const, revisionBefore: snapshot.revision, revisionAfter: snapshot.revision };
      }
      if (snapshot.format !== 1 || snapshot.state !== 'ok') {
        throw new VaultSchemaError(`Page ${safeId} cannot be adopted (${snapshot.issue ?? snapshot.state}).`);
      }
      const at = this.now().toISOString();
      const result = await this.commitPlans(new Map([[safeId, planUpgrade(snapshot, at)]]), `wiki.migrate:${safeId}`, (changes) => ({
        at,
        kind: 'migrate',
        title: `Adopted ${safeId} into the typed vault`,
        detail: describeChanges(changes),
      }));
      return result.changes[0] ?? null;
    });
  }

  /** Student-controlled retention: remove a page, keeping its last revision in .history/. */
  async removePage(id: string, expectedRevision: Revision): Promise<{ removed: boolean; revision: string | null }> {
    const safeId = assertRecordId(id, 'Page id');
    return this.lock.run(async () => {
      const read = await readManifest(this.root);
      const snapshot = await this.findPage(safeId, read.manifest);
      if (!snapshot) return { removed: false, revision: null };
      if (snapshot.state === 'newer_schema') {
        throw new VaultSchemaError(`Page ${safeId} was written by a newer engine; this engine will not remove it.`);
      }
      if (snapshot.revision !== expectedRevision) {
        throw new VaultConflictError(`Page ${safeId} is not at the revision you read.`, [
          { id: safeId, expected: expectedRevision, found: snapshot.revision, reason: snapshot.state === 'out_of_band' ? 'out_of_band' : 'revision_changed' },
        ]);
      }
      assertWritableManifest(read);
      const at = this.now().toISOString();
      const current = read.manifest ?? emptyManifest(at);
      const pages = { ...current.pages };
      delete pages[safeId];
      const remaining = (await this.listPagesWith(read.manifest)).filter((page) => page.id !== safeId);
      const entry: BrainLogEntry = { at, kind: 'remove', title: `Removed ${safeId}`, detail: 'The student removed this page; its last revision is in .history/.' };
      await this.commit(`wiki.remove:${safeId}`, [
        { kind: 'write', path: historyRelativePath(snapshot.kind, safeId, snapshot.revision), content: snapshot.raw },
        { kind: 'remove', path: snapshot.relativePath },
        ...this.catalogueSteps(remaining.map(indexEntryOf).filter(isIndexEntry), pages, current.sources, at, entry),
      ]);
      return { removed: true, revision: snapshot.revision };
    });
  }

  /**
   * Rebuilds the derived catalogue — index.md and the manifest's page map — from the files
   * actually on disk, through the journal like every other write. Pages keep their recorded
   * entries untouched (drift between a file and its record is a finding, not something a
   * repair should paper over); entries for files that are gone are dropped.
   */
  async repairCatalogue(): Promise<{ changed: boolean; pagesIndexed: number }> {
    return this.lock.run(async () => {
      const at = this.now().toISOString();
      const read = await readManifest(this.root);
      assertWritableManifest(read);
      const manifest = read.manifest ?? emptyManifest(at);
      const snapshots = await this.listPagesWith(manifest);
      const entries = snapshots.map(indexEntryOf).filter(isIndexEntry);
      const nextIndex = renderIndex(entries, at);

      const live = new Set(snapshots.map((page) => page.id));
      const pages: Record<string, ManifestPage> = {};
      for (const [id, entry] of Object.entries(manifest.pages)) {
        if (live.has(id)) pages[id] = entry;
      }
      for (const snapshot of snapshots) {
        // New pages join the catalogue; drifted ones keep the committed record so the
        // mismatch stays visible to the next check instead of being silently adopted.
        if (!pages[snapshot.id] && snapshot.format !== null) {
          pages[snapshot.id] = {
            kind: snapshot.kind,
            revision: snapshot.revision,
            sha256: snapshot.fileSha256,
            bytes: snapshot.bytes,
            updatedAt: snapshot.metadata?.updatedAt ?? snapshot.legacy?.updated ?? at,
          };
        }
      }

      const currentIndex = await readText(vaultPath(this.root, INDEX_FILE));
      const pagesChanged = JSON.stringify(pages) !== JSON.stringify(manifest.pages);
      if (currentIndex === nextIndex && !pagesChanged) return { changed: false, pagesIndexed: entries.length };

      const dropped = Object.keys(manifest.pages).length - Object.keys(pages).length;
      const entry: BrainLogEntry = {
        at,
        kind: 'maintenance',
        title: 'Rebuilt the wiki catalogue',
        detail: `${entries.length} page${entries.length === 1 ? '' : 's'} indexed${dropped > 0 ? `, ${dropped} dropped entr${dropped === 1 ? 'y' : 'ies'}` : ''}.`,
      };
      await this.commit('wiki.reindex', [
        { kind: 'write', path: INDEX_FILE, content: nextIndex },
        { kind: 'append', path: LOG_FILE, content: renderLogEntry(entry) },
        { kind: 'write', path: manifestPath(this.root), content: manifestJson({ schemaVersion: VAULT_LAYOUT_VERSION, updatedAt: at, pages, sources: manifest.sources }) },
      ]);
      log.info('wiki_catalogue_repaired', { root: this.root, pages: entries.length, pagesChanged });
      return { changed: true, pagesIndexed: entries.length };
    });
  }

  async readSource(id: string): Promise<SourceRecord | null> {
    const safeId = assertRecordId(id, 'Source id');
    const raw = await readJson<unknown>(sourceRecordPath(this.root, safeId), null);
    if (raw === null) return null;
    const record = SourceRecordSchema.safeParse(raw);
    return record.success ? record.data : null;
  }

  async listSources(): Promise<Record<string, SourceRecord>> {
    const sources: Record<string, SourceRecord> = {};
    for (const entry of await readdir(vaultPath(this.root, META_DIRECTORY, META_SOURCES_DIRECTORY), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const record = await this.readSource(entry.name.slice(0, -5));
      if (record) sources[record.id] = record;
    }
    return sources;
  }

  /** Reads an original back and checks it against the hash recorded when it was frozen. */
  async readSourceBytes(id: string, revision?: string): Promise<Buffer | null> {
    const safeId = assertRecordId(id, 'Source id');
    const [record, manifest] = await Promise.all([this.readSource(safeId), readManifest(this.root)]);
    if (!record) return null;
    const wanted = revision ?? record.revision;
    const entry = manifest.manifest?.sources[safeId];
    const relativePath = entry && entry.revision === wanted ? entry.path : rawRelativePath(safeId, wanted, record.mediaType);
    const bytes = await readBytes(vaultPath(this.root, relativePath));
    if (!bytes) return null;
    if (sha256Hex(bytes) !== record.sha256) {
      throw new VaultIntegrityError(`Source ${safeId} does not match the hash recorded for revision ${wanted}.`);
    }
    return bytes;
  }

  /**
   * Freezes an original. The first write of a revision wins and later writes must be byte-identical,
   * so nothing the keeper or the model does can replace a source the student already has.
   */
  async putSource(record: SourceRecord, bytes: Uint8Array): Promise<{ record: SourceRecord; alreadyPresent: boolean }> {
    const value = SourceRecordSchema.parse(record);
    const actual = sha256Hex(bytes);
    if (actual !== value.sha256) throw new VaultIntegrityError(`Source ${value.id} does not match the sha256 it declares.`);
    if (value.bytes !== bytes.length) throw new VaultIntegrityError(`Source ${value.id} does not match the byte count it declares.`);
    return this.lock.run(async () => {
      const at = this.now().toISOString();
      const read = await readManifest(this.root);
      assertWritableManifest(read);
      const manifest = read.manifest ?? emptyManifest(at);
      const relativePath = rawRelativePath(value.id, value.revision, value.mediaType);
      const target = vaultPath(this.root, relativePath);
      let alreadyPresent = false;
      try {
        await writeFileExclusive(target, bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readBytes(target);
        if (!existing || sha256Hex(existing) !== actual) {
          throw new VaultConflictError(`Source ${value.id} already holds a different snapshot at ${value.revision}.`, [
            { id: value.id, expected: null, found: value.revision, reason: 'exists' },
          ]);
        }
        alreadyPresent = true;
      }
      const recorded = manifest.sources[value.id];
      if (alreadyPresent && recorded?.sha256 === actual && recorded.revision === value.revision) return { record: value, alreadyPresent };
      const sources: Record<string, ManifestSource> = {
        ...manifest.sources,
        [value.id]: {
          revision: value.revision,
          mediaType: value.mediaType,
          sha256: actual,
          bytes: bytes.length,
          createdAt: value.createdAt,
          path: relativePath,
          extractions: value.extractions.length,
        },
      };
      const entry: BrainLogEntry = {
        at,
        kind: 'source',
        title: `Frozen source: ${value.title}`,
        detail: `${value.kind} from ${value.origin} · ${value.mediaType} · ${bytes.length} bytes · revision ${value.revision}`,
      };
      await this.commit(`wiki.source:${value.id}`, [
        { kind: 'write', path: sourceRecordStepPath(value.id), content: `${JSON.stringify(value, null, 2)}\n` },
        { kind: 'write', path: manifestPath(this.root), content: manifestJson({ ...manifest, updatedAt: at, sources }) },
        { kind: 'append', path: LOG_FILE, content: renderLogEntry(entry) },
      ]);
      return { record: value, alreadyPresent };
    });
  }

  /**
   * Records an extraction pass on the stored record. The ledger entry is metadata; when the
   * caller also hands over the extracted text it is frozen beside the record under
   * `.meta/sources/<id>/extracted/`, so a later compile does not have to re-run the reader
   * (vision especially) to get back the same words.
   */
  async recordExtraction(
    id: string,
    entry: { method: SourceRecord['extractions'][number]['method']; sha256: string; chars: number; partial: boolean; note?: string },
    text?: string,
  ): Promise<void> {
    const safeId = assertRecordId(id, 'Source id');
    await this.lock.run(async () => {
      const record = await this.readSource(safeId);
      if (!record) return;
      const read = await readManifest(this.root);
      assertWritableManifest(read);
      const at = this.now().toISOString();
      const manifest = read.manifest ?? emptyManifest(at);
      const existing = manifest.sources[safeId];
      if (!existing) return;
      const extraction = { revision: record.revision, createdAt: at, ...entry };
      const value = SourceRecordSchema.parse({ ...record, extractions: [...record.extractions, extraction] });
      const sources = { ...manifest.sources, [safeId]: { ...existing, extractions: value.extractions.length } };
      const steps: JournalStep[] = [
        { kind: 'write', path: sourceRecordStepPath(safeId), content: `${JSON.stringify(value, null, 2)}\n` },
        { kind: 'write', path: manifestPath(this.root), content: manifestJson({ ...manifest, updatedAt: at, sources }) },
      ];
      if (text !== undefined) {
        steps.push({ kind: 'write', path: extractionTextPath(safeId, extraction.revision, extraction.method), content: text });
      }
      await this.commit(`wiki.extraction:${safeId}`, steps);
    });
  }

  /**
   * Reads back what an extraction pass produced, defaulting to the latest recorded pass.
   * Returns null when the text was never persisted (records written before text freezing
   * existed, or a reader that produced nothing).
   */
  async readExtractionText(id: string, revision?: string): Promise<string | null> {
    const record = await this.readSource(id);
    if (!record) return null;
    const extraction = [...record.extractions].reverse().find((e) => (revision ? e.revision === revision : true));
    if (!extraction) return null;
    return readText(vaultPath(this.root, extractionTextPath(record.id, extraction.revision, extraction.method)));
  }

  /**
   * Every saved revision of one page, newest first: the current file plus the .history/
   * snapshots. Format-1 vaults kept history under .history/<id>, the typed layout nests it
   * by kind — both are read so adopted pages show their whole past.
   */
  async pageRevisions(id: string): Promise<PageRevisionList | null> {
    const safeId = assertRecordId(id, 'Page id');
    const snapshot = await this.readPage(safeId);
    if (!snapshot) return null;
    const revisions = new Map<string, { revision: string; at: string; current: boolean }>();
    for (const directory of [
      vaultPath(this.root, HISTORY_DIRECTORY, KIND_DIRECTORY[snapshot.kind], safeId),
      vaultPath(this.root, HISTORY_DIRECTORY, safeId),
    ]) {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const revision = entry.name.slice(0, -3);
        if (revisions.has(revision)) continue;
        const info = await stat(path.join(directory, entry.name)).catch(() => null);
        revisions.set(revision, { revision, at: info?.mtime.toISOString() ?? snapshot.revision, current: revision === snapshot.revision });
      }
    }
    const list = [...revisions.values()].sort((a, b) => b.at.localeCompare(a.at));
    if (!list.some((entry) => entry.current)) {
      const at = snapshot.metadata?.updatedAt ?? snapshot.legacy?.updated ?? this.now().toISOString();
      list.unshift({ revision: snapshot.revision, at, current: true });
    }
    return { pageId: safeId, current: snapshot.revision, revisions: list };
  }

  /** One revision's page file, verbatim — the current file or a .history/ snapshot. */
  async readPageRevision(id: string, revision: string): Promise<PageRevisionContent | null> {
    const safeId = assertRecordId(id, 'Page id');
    let safeRevision: string;
    try {
      safeRevision = assertSafeRevision(revision, 'Revision');
    } catch {
      return null;
    }
    const snapshot = await this.readPage(safeId);
    if (!snapshot) return null;
    if (safeRevision === snapshot.revision) {
      return { pageId: safeId, revision: snapshot.revision, raw: snapshot.raw, current: true };
    }
    for (const relativePath of [
      historyRelativePath(snapshot.kind, safeId, safeRevision),
      `${HISTORY_DIRECTORY}/${safeId}/${safeRevision}.md`,
    ]) {
      const raw = await readText(vaultPath(this.root, relativePath));
      if (raw !== null) return { pageId: safeId, revision: safeRevision, raw, current: false };
    }
    return null;
  }

  /**
   * Every page that still leans on a source: its page-level sourceIds, each claim or link
   * that cites it, and learner evidence that names it. The student sees this list before
   * erasing, and it is what an erasure honestly orphans.
   */
  async sourceDependents(id: string): Promise<SourceDependents['pages']> {
    const safeId = assertRecordId(id, 'Source id');
    const pages: SourceDependents['pages'] = [];
    for (const snapshot of await this.listPages()) {
      const metadata = snapshot.metadata;
      if (!metadata) continue;
      const references: string[] = [];
      if (metadata.sourceIds.includes(safeId)) references.push('page');
      for (const claim of metadata.claims) {
        if (claim.citations.some((citation) => citation.sourceId === safeId)) references.push(`claim ${claim.id}`);
      }
      for (const link of metadata.links) {
        if (link.citations.some((citation) => citation.sourceId === safeId)) references.push(`link → ${link.toPageId}`);
      }
      if (metadata.learner?.evidenceIds.includes(safeId)) references.push('learner evidence');
      if (references.length) pages.push({ id: snapshot.id, kind: metadata.kind, title: metadata.title, references });
    }
    return pages;
  }

  /** Student-controlled erasure: the only path that may touch raw/. */
  async eraseSource(id: string, expectedRevision?: Revision): Promise<{ erased: boolean; dependents: SourceDependents['pages'] }> {
    const safeId = assertRecordId(id, 'Source id');
    return this.lock.run(async () => {
      const record = await this.readSource(safeId);
      if (!record) return { erased: false, dependents: [] };
      if (expectedRevision && record.revision !== expectedRevision) {
        throw new VaultConflictError(`Source ${safeId} is not at the revision you read.`, [
          { id: safeId, expected: expectedRevision, found: record.revision, reason: 'revision_changed' },
        ]);
      }
      const dependents = await this.sourceDependents(safeId);
      const read = await readManifest(this.root);
      assertWritableManifest(read);
      const at = this.now().toISOString();
      const current = read.manifest ?? emptyManifest(at);
      const entry = current.sources[safeId];
      const sources = { ...current.sources };
      delete sources[safeId];
      const logEntry: BrainLogEntry = { at, kind: 'erase', title: `Erased source ${safeId}`, detail: 'The student removed this source; the page metadata that cited it stays.' };
      // A tombstone replaces the record: the delete is recorded, not hidden, and a future
      // sync can carry it. Derived extraction text goes with the source it came from.
      const tombstone: SourceTombstone = SourceTombstoneSchema.parse({
        schemaVersion: CONTRACT_VERSION,
        id: record.id,
        revision: record.revision,
        kind: record.kind,
        mediaType: record.mediaType,
        sha256: record.sha256,
        erasedAt: at,
      });
      const extractedDir = `${META_DIRECTORY}/${META_SOURCES_DIRECTORY}/${safeId}/extracted`;
      const extracted = await readdir(vaultPath(this.root, extractedDir)).catch(() => [] as string[]);
      const steps: JournalStep[] = [
        ...(entry ? [{ kind: 'remove' as const, path: entry.path }] : []),
        ...extracted.filter((file) => file.endsWith('.txt')).map((file) => ({ kind: 'remove' as const, path: `${extractedDir}/${file}` })),
        { kind: 'remove', path: sourceRecordStepPath(safeId) },
        { kind: 'write', path: `${META_DIRECTORY}/${META_TOMBSTONES_DIRECTORY}/${safeId}.json`, content: `${JSON.stringify(tombstone, null, 2)}\n` },
        { kind: 'write', path: manifestPath(this.root), content: manifestJson({ ...current, updatedAt: at, sources }) },
        { kind: 'append', path: LOG_FILE, content: renderLogEntry(logEntry) },
      ];
      await this.commit(`wiki.erase:${safeId}`, steps, { allowRaw: true });
      return { erased: true, dependents };
    });
  }

  /**
   * The growth ledger: every derived learning event, oldest first, optionally narrowed to one
   * page. Event files are keyed by the revision they committed, so unreadable or unknown files
   * are skipped rather than trusted.
   */
  async listEvents(pageId?: string): Promise<LearningEvent[]> {
    const directory = vaultPath(this.root, META_DIRECTORY, META_EVENTS_DIRECTORY);
    const events: LearningEvent[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const raw = await readJson<unknown>(path.join(directory, entry.name), null);
      const parsed = raw === null ? null : LearningEventSchema.safeParse(raw);
      if (parsed?.success) events.push(parsed.data);
      else if (raw !== null) log.warn('vault_event_unreadable', { root: this.root, file: entry.name });
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return pageId ? events.filter((event) => event.pageId === pageId) : events;
  }

  async writeJob(job: WikiJob): Promise<void> {
    await writeJob(this.root, job);
  }

  readJob(id: string): Promise<WikiJob | null> {
    return readJob(this.root, id);
  }

  listJobs(): Promise<WikiJob[]> {
    return listJobs(this.root);
  }

  private async findPage(id: string, manifest: VaultManifest | null): Promise<PageSnapshot | null> {
    let found: PageSnapshot | null = null;
    for (const kind of PAGE_KINDS) {
      const snapshot = await this.snapshot(kind, pageRelativePath(kind, id), manifest);
      if (!snapshot) continue;
      if (!found) {
        found = snapshot;
        continue;
      }
      log.warn('vault_page_duplicated', { root: this.root, id });
      return { ...found, state: 'out_of_band', issue: 'the same page id exists in more than one kind folder' };
    }
    return found;
  }

  private async listPagesWith(manifest: VaultManifest | null): Promise<PageSnapshot[]> {
    const pages: PageSnapshot[] = [];
    for (const kind of PAGE_KINDS) {
      const directory = KIND_DIRECTORY[kind];
      for (const entry of await readdir(vaultPath(this.root, directory), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile()) continue;
        if (!pageIdFromFileName(entry.name)) {
          if (entry.name.endsWith('.md')) log.warn('vault_page_unsafe_name', { root: this.root, file: entry.name });
          continue;
        }
        const snapshot = await this.snapshot(kind, `${directory}/${entry.name}`, manifest);
        if (snapshot) pages.push(snapshot);
      }
    }
    return pages.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async snapshot(kind: PageKind, relativePath: string, manifest: VaultManifest | null): Promise<PageSnapshot | null> {
    const raw = await readPageText(vaultPath(this.root, relativePath));
    if (raw === null) return null;
    const id = pageIdFromFileName(path.basename(relativePath));
    if (!id) return null;
    return pageSnapshotFromContent(kind, relativePath, raw, manifest?.pages[id]);
  }

  private async commitPlans(
    plans: Map<string, PagePlan>,
    intent: string,
    buildLogEntry: (changes: PageChange[]) => BrainLogEntry,
    extraSteps: JournalStep[] = [],
  ): Promise<{ committed: boolean; journalId: string | null; changes: PageChange[]; logEntry: BrainLogEntry }> {
    const at = this.now().toISOString();
    const read = await readManifest(this.root);
    assertWritableManifest(read);
    const manifest = read.manifest ?? emptyManifest(at);
    const pages: Record<string, ManifestPage> = { ...manifest.pages };
    const steps: JournalStep[] = [];
    const changes: PageChange[] = [];

    for (const [id, plan] of plans) {
      const kind = plan.content.metadata.kind;
      const relativePath = pageRelativePath(kind, id);
      const content = stamped(plan.content);
      const nextFile = serializePageFile(content);
      const previous = plan.snapshot;
      if (previous && previous.relativePath === relativePath && previous.raw === nextFile) {
        changes.push({ id, kind, change: 'unchanged', revisionBefore: previous.revision, revisionAfter: content.metadata.revision });
        continue;
      }
      // History first: the previous revision is on disk before the new one takes its place.
      if (previous) steps.push({ kind: 'write', path: historyRelativePath(previous.kind, id, previous.revision), content: previous.raw });
      if (previous && previous.relativePath !== relativePath) steps.push({ kind: 'remove', path: previous.relativePath });
      steps.push({ kind: 'write', path: relativePath, content: nextFile });
      pages[id] = { kind, revision: content.metadata.revision, sha256: sha256Hex(nextFile), bytes: Buffer.byteLength(nextFile), updatedAt: at };
      changes.push({
        id,
        kind,
        change: plan.created ? 'created' : 'updated',
        revisionBefore: previous?.revision ?? null,
        revisionAfter: content.metadata.revision,
      });
    }

    const logEntry = buildLogEntry(changes.filter((change) => change.change !== 'unchanged'));
    if (!steps.length) {
      if (!extraSteps.length) return { committed: false, journalId: null, changes, logEntry };
      // Pages already hold these revisions — a replayed proposal. The growth events may still
      // be missing from an interrupted commit, so they persist on their own journal; nothing
      // else (index, manifest, log) moves, because nothing changed.
      const journalId = await this.commit(`${intent}:growth`, extraSteps);
      return { committed: true, journalId, changes, logEntry };
    }

    const written = new Set(changes.filter((change) => change.change !== 'unchanged').map((change) => change.id));
    const indexEntries: IndexEntry[] = [];
    for (const snapshot of await this.listPagesWith(manifest)) {
      if (written.has(snapshot.id)) continue;
      const row = indexEntryOf(snapshot);
      if (row) indexEntries.push(row);
    }
    for (const [id, plan] of plans) {
      if (written.has(id)) indexEntries.push(indexEntryOfContent(plan.content));
    }

    const journalId = await this.commit(intent, [...steps, ...extraSteps, ...this.catalogueSteps(indexEntries, pages, manifest.sources, at, logEntry)]);
    return { committed: true, journalId, changes, logEntry };
  }

  private catalogueSteps(
    indexEntries: IndexEntry[],
    pages: Record<string, ManifestPage>,
    sources: Record<string, ManifestSource>,
    at: string,
    logEntry: BrainLogEntry,
  ): JournalStep[] {
    return [
      { kind: 'write', path: INDEX_FILE, content: renderIndex(indexEntries, at) },
      { kind: 'append', path: LOG_FILE, content: renderLogEntry(logEntry) },
      { kind: 'write', path: manifestPath(this.root), content: manifestJson({ schemaVersion: VAULT_LAYOUT_VERSION, updatedAt: at, pages, sources }) },
    ];
  }

  /**
   * The verbatim restore path (vault portability): the caller supplies complete journal
   * steps — page bytes, catalogue, log — plus the sha each touched path held when the plan
   * was previewed. Preconditions are re-checked inside the writer lock, so a vault that
   * moved between preview and commit is refused rather than silently overwritten. Nothing
   * here derives content; restored pages keep their committed bytes and revisions.
   */
  async commitRestore(
    intent: string,
    steps: JournalStep[],
    options: { preconditions?: { path: string; sha256: string | null }[] } = {},
  ): Promise<string> {
    return this.lock.run(async () => {
      for (const pre of options.preconditions ?? []) {
        const relativePath = assertRelativeVaultPath(pre.path);
        const current = await readBytes(vaultPath(this.root, relativePath));
        const found = current ? sha256Hex(current) : null;
        if (found !== pre.sha256) {
          throw new VaultConflictError(`The vault changed since this restore was previewed: ${relativePath} no longer matches.`, [
            { id: relativePath, expected: pre.sha256, found, reason: 'revision_changed' },
          ]);
        }
      }
      return this.commit(intent, steps, { allowRaw: true });
    });
  }

  /** One journal, then the steps. Interrupted commits are finished by recover(), never half-applied. */
  private async commit(intent: string, steps: JournalStep[], options: { allowRaw?: boolean } = {}): Promise<string> {
    for (const step of steps) {
      if (!options.allowRaw && isRawPath(step.path)) {
        throw new VaultIntegrityError(`Refusing to write ${step.path}: source originals are immutable.`);
      }
    }
    const journal = await beginJournal(this.root, intent, steps);
    try {
      await applyJournalSteps(this.root, steps);
    } catch (error) {
      log.error('vault_commit_interrupted', { root: this.root, journal: journal.id, intent, ...errorFields(error) });
      throw error;
    }
    await completeJournal(this.root, journal.id);
    return journal.id;
  }
}

function isIndexEntry(entry: IndexEntry | null): entry is IndexEntry {
  return entry !== null;
}

/** A directory (or a symlink loop) where a page file belongs is not a page: readers skip it, writers fail loudly. */
async function readPageText(file: string): Promise<string | null> {
  try {
    return await readText(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function describeConflicts(conflicts: VaultConflictDetail[]): string {
  return `The vault changed since this proposal was prepared: ${conflicts
    .map((conflict) => `${conflict.id} is ${conflict.reason} (expected ${conflict.expected ?? 'a new page'}, found ${conflict.found ?? 'nothing'})`)
    .join('; ')}.`;
}

function describeChanges(changes: PageChange[]): string {
  if (!changes.length) return 'nothing changed';
  const detail = changes.map((change) => `${change.change} ${change.id} → ${change.revisionAfter}`).join(', ');
  return `${changes.length} page${changes.length === 1 ? '' : 's'}: ${detail}`.slice(0, 800);
}

function manifestPath(root: string): string {
  return path.relative(root, vaultPath(root, META_DIRECTORY, META_MANIFEST_FILE));
}

function sourceRecordPath(root: string, id: string): string {
  return vaultPath(root, META_DIRECTORY, META_SOURCES_DIRECTORY, `${id}.json`);
}

function sourceRecordStepPath(id: string): string {
  return `${META_DIRECTORY}/${META_SOURCES_DIRECTORY}/${id}.json`;
}

/** Extracted text is derived data: a revision+method pair names it, never content hashes the model could collide. */
function extractionTextPath(id: string, revision: string, method: string): string {
  return `${META_DIRECTORY}/${META_SOURCES_DIRECTORY}/${assertRecordId(id, 'Source id')}/extracted/${assertSafeRevision(revision, 'Source revision')}-${assertSafeRevision(method, 'Extraction method')}.txt`;
}

function manifestJson(manifest: VaultManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
