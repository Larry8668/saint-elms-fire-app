import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SourceRecordSchema, WikiProposalSchema, type BrainLogEntry, type Revision, type SourceRecord, type WikiJob, type WikiProposal } from '@sef/shared';
import { errorFields, log } from '../config';
import { readBytes, readJson, readText, writeFileAtomic, writeFileExclusive } from '../lib/fs';
import { sha256Hex } from '../lib/hash';
import { renderIndex, type IndexEntry } from './index-format';
import { recentLogEntries, renderLogEntry } from './log-format';
import { ensureConventionsFile, readConventions, type ConventionsRead } from './schema-conventions';
import { VaultConflictError, VaultIntegrityError, VaultSchemaError, type VaultConflictDetail } from './vault-errors';
import { listJobs, readJob, writeJob } from './vault-jobs';
import { applyJournalSteps, beginJournal, completeJournal, pendingJournals, recoverJournals, type JournalStep, type RecoveryReport } from './vault-journal';
import { VaultLock, type VaultLockOptions } from './vault-lock';
import {
  INDEX_FILE,
  KIND_DIRECTORY,
  LOG_FILE,
  META_DIRECTORY,
  META_MANIFEST_FILE,
  META_SOURCES_DIRECTORY,
  PAGE_KINDS,
  VAULT_DIRECTORIES,
  VAULT_LAYOUT_VERSION,
  assertRecordId,
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
import { indexEntryOf, indexEntryOfContent, planProposal, planUpgrade, stamped, type PageChange, type PagePlan, type PageSnapshot } from './wiki-plan';
import { readPageFile, revisionMatches, serializePageFile } from './wiki-page-format';

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
      const result = await this.commitPlans(plan.plans, `wiki.proposal:${value.id}`, (changes) => ({
        at,
        kind: 'wiki',
        title: `Wiki update from proposal ${value.id}`,
        detail: describeChanges(changes),
      }));
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

  /** Student-controlled erasure: the only path that may touch raw/. */
  async eraseSource(id: string, expectedRevision?: Revision): Promise<{ erased: boolean }> {
    const safeId = assertRecordId(id, 'Source id');
    return this.lock.run(async () => {
      const record = await this.readSource(safeId);
      if (!record) return { erased: false };
      if (expectedRevision && record.revision !== expectedRevision) {
        throw new VaultConflictError(`Source ${safeId} is not at the revision you read.`, [
          { id: safeId, expected: expectedRevision, found: record.revision, reason: 'revision_changed' },
        ]);
      }
      const read = await readManifest(this.root);
      assertWritableManifest(read);
      const at = this.now().toISOString();
      const current = read.manifest ?? emptyManifest(at);
      const entry = current.sources[safeId];
      const sources = { ...current.sources };
      delete sources[safeId];
      const logEntry: BrainLogEntry = { at, kind: 'erase', title: `Erased source ${safeId}`, detail: 'The student removed this source; the page metadata that cited it stays.' };
      const steps: JournalStep[] = [
        ...(entry ? [{ kind: 'remove' as const, path: entry.path }] : []),
        { kind: 'remove', path: sourceRecordStepPath(safeId) },
        { kind: 'write', path: manifestPath(this.root), content: manifestJson({ ...current, updatedAt: at, sources }) },
        { kind: 'append', path: LOG_FILE, content: renderLogEntry(logEntry) },
      ];
      await this.commit(`wiki.erase:${safeId}`, steps, { allowRaw: true });
      return { erased: true };
    });
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
    const fileSha256 = sha256Hex(raw);
    const bytes = Buffer.byteLength(raw);
    const parsed = readPageFile(raw);
    if (parsed.format === 2) {
      const recorded = manifest?.pages[id];
      const drifted = !revisionMatches(parsed.metadata, parsed.body) || parsed.metadata.kind !== kind || (recorded !== undefined && recorded.sha256 !== fileSha256);
      return {
        id,
        kind: parsed.metadata.kind,
        format: 2,
        relativePath,
        revision: drifted ? `file-${fileSha256.slice(0, 40)}` : parsed.metadata.revision,
        state: drifted ? 'out_of_band' : 'ok',
        metadata: parsed.metadata,
        legacy: null,
        body: parsed.body,
        raw,
        fileSha256,
        bytes,
        ...(drifted ? { issue: 'the page changed outside the keeper' } : {}),
      };
    }
    if (parsed.format === 1) {
      return {
        id,
        kind,
        format: 1,
        relativePath,
        revision: `file-${fileSha256.slice(0, 40)}`,
        state: 'ok',
        metadata: null,
        legacy: parsed.legacy,
        body: parsed.body,
        raw,
        fileSha256,
        bytes,
      };
    }
    return {
      id,
      kind,
      format: null,
      relativePath,
      revision: `file-${fileSha256.slice(0, 40)}`,
      state: parsed.reason === 'newer_schema' ? 'newer_schema' : 'malformed',
      metadata: null,
      legacy: null,
      body: '',
      raw,
      fileSha256,
      bytes,
      issue: parsed.message,
    };
  }

  private async commitPlans(
    plans: Map<string, PagePlan>,
    intent: string,
    buildLogEntry: (changes: PageChange[]) => BrainLogEntry,
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
    if (!steps.length) return { committed: false, journalId: null, changes, logEntry };

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

    const journalId = await this.commit(intent, [...steps, ...this.catalogueSteps(indexEntries, pages, manifest.sources, at, logEntry)]);
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

function manifestJson(manifest: VaultManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
