import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CONTRACT_VERSION,
  LearningEventSchema,
  SourceRecordSchema,
  SourceTombstoneSchema,
  VAULT_EXPORT_KIND,
  VAULT_EXPORT_VERSION,
  type BrainLogEntry,
  type ProfileIdentity,
  type SourceRecord,
  type VaultExport,
  type VaultExportFile,
  type VaultImportConflict,
  type VaultImportPlan,
  type VaultImportPreview,
  type VaultImportResult,
} from '@sef/shared';
import { z } from 'zod';
import { log } from '../../config';
import { readBytes, readText } from '../../lib/fs';
import { sha256Hex } from '../../lib/hash';
import { renderIndex, type IndexEntry } from '../index-format';
import { renderLogEntry } from '../log-format';
import { checkMediaType } from '../sources/limits';
import { VaultSchemaError } from '../vault-errors';
import type { JournalStep } from '../vault-journal';
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
  RAW_DIRECTORY,
  VAULT_LAYOUT_VERSION,
  historyRelativePath,
  pageIdFromFileName,
  rawRelativePath,
  vaultPath,
} from '../vault-layout';
import { emptyManifest, readManifest, type VaultManifestPage, type VaultManifestSource } from '../vault-manifest';
import { indexEntryOf, pageSnapshotFromContent, type PageSnapshot } from '../wiki-plan';
import type { WikiStore } from '../wiki-store';
import { VaultImportError, classifyArchivePath, parseArchive, type ArchiveFile, type PortableLimits } from './archive';

/** What the store re-checks inside the writer lock: the sha each touched path held at preview time. */
interface Precondition {
  path: string;
  sha256: string | null;
}

interface FileDecision {
  file: VaultExportFile;
  area: ArchiveFile;
  /** 'write' adds a journal step; 'skip' is listed honestly with its reason; 'unchanged' is already on disk. */
  action: 'write' | 'skip' | 'unchanged';
  reason?: string;
}

interface ImportPlan {
  steps: JournalStep[];
  preconditions: Precondition[];
  decisions: FileDecision[];
  conflicts: VaultImportConflict[];
  warnings: string[];
  plan: VaultImportPlan;
  applied: VaultImportResult['applied'];
}

export interface VaultPortabilityDeps {
  /** The exporting profile's public identity — provenance for the manifest, never trusted back. */
  identity: () => Promise<ProfileIdentity>;
  now?: () => Date;
  limits?: PortableLimits;
}

/**
 * Vault portability: export carries the student's own knowledge — pages, page history, source
 * records and originals, the growth ledger, erasure tombstones and the learning log — as a
 * checksummed file set. Restore previews, then writes through the vault journal: nothing is
 * re-serialised, so stable ids, revisions and provenance (including accepted peer sources)
 * arrive byte-for-byte. Derived state (index, manifest, conventions) is rebuilt from the
 * imported bytes, never trusted from an archive; in-flight and credential material never
 * enters one.
 */
export class VaultPortabilityService {
  private readonly now: () => Date;
  private readonly limits: PortableLimits;

  constructor(
    private readonly wiki: WikiStore,
    private readonly deps: VaultPortabilityDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.limits = deps.limits ?? {};
  }

  /** Everything the student owns, as one manifest-listed file set. */
  async exportVault(options: { sourceIds?: string[] } = {}): Promise<VaultExport> {
    const root = this.wiki.root;
    const files: VaultExportFile[] = [];
    const skipped: string[] = [];
    const counts = { pages: 0, history: 0, sources: 0, events: 0, tombstones: 0 };

    const push = (relativePath: string, content: string | Uint8Array, area?: 'pages' | 'history' | 'sources' | 'events' | 'tombstones') => {
      files.push({
        path: relativePath,
        sha256: sha256Hex(content),
        bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength,
        encoding: typeof content === 'string' ? 'utf8' : 'base64',
        content: typeof content === 'string' ? content : Buffer.from(content).toString('base64'),
      });
      if (area) counts[area] += 1;
    };

    // Pages: every page file in every kind directory, verbatim — readable or not, it is theirs.
    for (const kind of PAGE_KINDS) {
      const directory = KIND_DIRECTORY[kind];
      for (const entry of await readdir(vaultPath(root, directory), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile()) continue;
        const relativePath = `${directory}/${entry.name}`;
        if (!entry.name.endsWith('.md') || !pageIdFromFileName(entry.name)) {
          skipped.push(relativePath);
          continue;
        }
        const text = await readText(vaultPath(root, relativePath));
        if (text === null) continue;
        push(relativePath, text, 'pages');
      }
    }

    // Page history: every snapshot under .history/, at whatever depth the layout keeps it.
    for (const relativePath of await walkFiles(vaultPath(root, HISTORY_DIRECTORY), root)) {
      const text = await readText(vaultPath(root, relativePath));
      if (text !== null) push(relativePath, text, 'history');
    }

    // Source records plus their extraction-ledger text; originals only for the selected set.
    const selected = options.sourceIds ? new Set(options.sourceIds) : null;
    const manifest = (await readManifest(root)).manifest;
    const records = await this.wiki.listSources();
    for (const record of Object.values(records)) {
      const recordPath = `${META_DIRECTORY}/${META_SOURCES_DIRECTORY}/${record.id}.json`;
      const recordText = await readText(vaultPath(root, recordPath));
      if (recordText !== null) push(recordPath, recordText, 'sources');
      const extractedDir = `${META_DIRECTORY}/${META_SOURCES_DIRECTORY}/${record.id}/extracted`;
      for (const file of await readdir(vaultPath(root, extractedDir)).catch(() => [] as string[])) {
        if (!file.endsWith('.txt')) continue;
        const text = await readText(vaultPath(root, extractedDir, file));
        if (text !== null) push(`${extractedDir}/${file}`, text);
      }
      const rawPath = manifest?.sources[record.id]?.path ?? rawRelativePath(record.id, record.revision, record.mediaType);
      if (selected && !selected.has(record.id)) {
        skipped.push(rawPath);
        continue;
      }
      const bytes = await readBytes(vaultPath(root, rawPath));
      if (bytes) push(rawPath, bytes);
      else skipped.push(rawPath);
    }

    // Raw files with no live record still belong to the student — carried on a full export only.
    for (const entry of await readdir(vaultPath(root, RAW_DIRECTORY), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || records[entry.name]) continue;
      const prefix = `${RAW_DIRECTORY}/${entry.name}`;
      if (selected) {
        skipped.push(`${prefix}/…`);
        continue;
      }
      for (const relativePath of await walkFiles(vaultPath(root, prefix), root)) {
        if (classifyArchivePath(relativePath)?.area !== 'raw') {
          skipped.push(relativePath);
          continue;
        }
        const bytes = await readBytes(vaultPath(root, relativePath));
        if (bytes) push(relativePath, bytes);
      }
    }

    // The growth ledger and the erasure markers a future sync will need.
    for (const [directory, area] of [
      [META_EVENTS_DIRECTORY, 'events'],
      [META_TOMBSTONES_DIRECTORY, 'tombstones'],
    ] as const) {
      for (const file of await readdir(vaultPath(root, META_DIRECTORY, directory)).catch(() => [] as string[])) {
        if (!file.endsWith('.json')) continue;
        const relativePath = `${META_DIRECTORY}/${directory}/${file}`;
        const text = await readText(vaultPath(root, relativePath));
        if (text !== null) push(relativePath, text, area);
      }
    }

    const logText = await readText(vaultPath(root, LOG_FILE));
    if (logText !== null) push(LOG_FILE, logText);

    files.sort((a, b) => a.path.localeCompare(b.path));
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    const archive: VaultExport = {
      schemaVersion: VAULT_EXPORT_VERSION,
      kind: VAULT_EXPORT_KIND,
      createdAt: this.now().toISOString(),
      layout: VAULT_LAYOUT_VERSION,
      exportedBy: await this.deps.identity(),
      counts: { ...counts, files: files.length, bytes: totalBytes },
      files,
      skipped: skipped.sort(),
    };
    log.info('vault_exported', { root, files: files.length, bytes: totalBytes, skipped: skipped.length });
    return archive;
  }

  /** What a restore would do — destination state, conflicts and size, computed before any write. */
  async previewImport(raw: unknown): Promise<VaultImportPreview> {
    const base = { schemaVersion: CONTRACT_VERSION, conflicts: [] as VaultImportConflict[], warnings: [] as string[] };
    let archive: VaultExport;
    try {
      archive = parseArchive(raw, this.limits);
    } catch (error) {
      if (error instanceof VaultImportError) return { ...base, state: 'refused', code: error.code, reason: error.message };
      throw error;
    }
    let planned: ImportPlan;
    try {
      planned = await this.planImport(archive, new Set());
    } catch (error) {
      if (error instanceof VaultSchemaError) {
        return { ...base, state: 'refused', code: 'incompatible_schema', reason: error.message };
      }
      if (error instanceof VaultImportError) {
        return { ...base, state: 'refused', code: error.code, reason: error.message };
      }
      throw error;
    }
    const [pages, sources] = await Promise.all([this.wiki.listPages(), this.wiki.listSources()]);
    return {
      ...base,
      state: planned.conflicts.length ? 'conflicts' : 'ready',
      archive: { createdAt: archive.createdAt, exportedBy: archive.exportedBy, layout: archive.layout, counts: archive.counts },
      destination: { pages: pages.length, sources: Object.keys(sources).length },
      conflicts: planned.conflicts,
      plan: planned.plan,
      warnings: planned.warnings,
    };
  }

  /**
   * The restore itself: the archive is re-validated and the plan re-derived, then every write
   * lands through one journal. Pages in conflict are skipped unless the student named them in
   * `overwritePageIds` — an imported revision never silently replaces a live one.
   */
  async restore(raw: unknown, options: { overwritePageIds?: string[] } = {}): Promise<VaultImportResult> {
    const archive = parseArchive(raw, this.limits);
    const planned = await this.planImport(archive, new Set(options.overwritePageIds ?? []));
    const journalId = await this.wiki.commitRestore(`vault.restore:${archive.createdAt}`, planned.steps, { preconditions: planned.preconditions });
    log.info('vault_restored', {
      root: this.wiki.root,
      journalId,
      pages: planned.applied.pages,
      sources: planned.applied.sources,
      conflicts: planned.conflicts.length,
    });
    return {
      schemaVersion: CONTRACT_VERSION,
      committed: true,
      journalId,
      applied: planned.applied,
      skipped: planned.decisions.filter((d) => d.action === 'skip').map((d) => ({ path: d.file.path, reason: d.reason ?? 'not needed' })),
      conflicts: planned.conflicts,
    };
  }

  /**
   * Turns a validated archive into journal steps plus the preconditions that make the commit
   * safe: every path the plan touches is recorded with the sha it held at preview time, so a
   * vault that moved in between is refused rather than overwritten blind.
   */
  private async planImport(archive: VaultExport, overwritePageIds: Set<string>): Promise<ImportPlan> {
    const root = this.wiki.root;
    const at = this.now().toISOString();
    const warnings: string[] = [];
    const conflicts: VaultImportConflict[] = [];
    const decisions: FileDecision[] = [];
    const preconditions: Precondition[] = [];
    const steps: JournalStep[] = [];
    const applied: VaultImportResult['applied'] = { pages: 0, sources: 0, rawFiles: 0, history: 0, events: 0, tombstones: 0, logEntries: 0 };

    const existingPages = new Map((await this.wiki.listPages()).map((page) => [page.id, page]));
    const existingSources = await this.wiki.listSources();
    const manifestRead = await readManifest(root);
    if (manifestRead.integrity === 'newer_schema') {
      throw new VaultSchemaError('This vault was written by a newer engine; refusing to restore into it.');
    }
    if (manifestRead.integrity === 'invalid') {
      throw new VaultImportError('The vault manifest is unreadable; repair it before restoring an export.', 'unsafe', 409);
    }
    const manifest = manifestRead.manifest ?? emptyManifest(at);

    const shaOf = async (relativePath: string): Promise<string | null> => {
      const bytes = await readBytes(vaultPath(root, relativePath));
      return bytes ? sha256Hex(bytes) : null;
    };

    // Records are parsed once up front so raw bytes can be checked against what they declare.
    const archiveRecords = new Map<string, SourceRecord>();
    const invalidRecordPaths = new Set<string>();
    for (const file of archive.files) {
      const area = classifyArchivePath(file.path);
      if (area?.area !== 'source_record') continue;
      const record = parseJson(file.content, SourceRecordSchema);
      if (!record || record.id !== area.id) {
        warnings.push(`Source record ${file.path} is not a valid record and will not be restored.`);
        invalidRecordPaths.add(file.path);
        continue;
      }
      // The stored media type later reaches the raw route's Content-Type decision, so an
      // archive cannot plant one this engine would never serve.
      if (checkMediaType(record.mediaType)) {
        warnings.push(`Source record ${file.path} declares media type '${record.mediaType}', which this engine does not accept, and will not be restored.`);
        invalidRecordPaths.add(file.path);
        continue;
      }
      archiveRecords.set(area.id, record);
    }

    const importedPageSnapshots = new Map<string, PageSnapshot>();
    const importedSources = new Map<string, { record: SourceRecord; rawPath: string }>();
    const overwrittenIds = new Set<string>();
    const preservedHistory = new Set<string>();

    for (const file of archive.files) {
      const area = classifyArchivePath(file.path)!;
      const existingSha = await shaOf(file.path);
      if (existingSha === file.sha256) {
        decisions.push({ file, area, action: 'unchanged' });
        continue;
      }

      switch (area.area) {
        case 'page': {
          const imported = pageSnapshotFromContent(area.kind, file.path, file.content, undefined);
          const existing = existingPages.get(area.id);
          if (!existing) {
            if (!imported) {
              warnings.push(`${file.path} has no safe page id and will not be restored.`);
              decisions.push({ file, area, action: 'skip', reason: 'unsafe page name' });
              break;
            }
            steps.push({ kind: 'write', path: file.path, content: file.content });
            preconditions.push({ path: file.path, sha256: null });
            importedPageSnapshots.set(area.id, imported);
            decisions.push({ file, area, action: 'write' });
            applied.pages += 1;
            break;
          }
          const importedRevision = imported?.revision ?? `file-${file.sha256.slice(0, 40)}`;
          const moved = existing.relativePath !== file.path;
          const resolvable = existing.state === 'ok' || existing.state === 'out_of_band';
          if (!resolvable || !overwritePageIds.has(area.id)) {
            conflicts.push({
              area: 'page',
              path: file.path,
              id: area.id,
              reason: moved ? 'moved' : 'different_revision',
              existing: existing.revision,
              imported: importedRevision,
              resolvable,
            });
            decisions.push({ file, area, action: 'skip', reason: 'page conflict' });
            break;
          }
          // Chosen overwrite: the live revision is preserved to .history/ before the imported
          // bytes take the path, so the student's newer work is never lost to a restore.
          const historyPath = historyRelativePath(existing.kind, existing.id, existing.revision);
          if (!preservedHistory.has(historyPath) && (await shaOf(historyPath)) === null) {
            steps.push({ kind: 'write', path: historyPath, content: existing.raw });
            preconditions.push({ path: historyPath, sha256: null });
            preservedHistory.add(historyPath);
          }
          if (moved) {
            steps.push({ kind: 'remove', path: existing.relativePath });
            preconditions.push({ path: existing.relativePath, sha256: existing.fileSha256 });
          }
          steps.push({ kind: 'write', path: file.path, content: file.content });
          preconditions.push({ path: file.path, sha256: existingSha });
          if (imported) importedPageSnapshots.set(area.id, imported);
          overwrittenIds.add(area.id);
          decisions.push({ file, area, action: 'write' });
          applied.pages += 1;
          break;
        }

        case 'history': {
          if (existingSha === null) {
            steps.push({ kind: 'write', path: file.path, content: file.content });
            preconditions.push({ path: file.path, sha256: null });
            decisions.push({ file, area, action: 'write' });
            applied.history += 1;
          } else {
            conflicts.push({ area: 'history', path: file.path, reason: 'different_bytes', existing: existingSha, imported: file.sha256, resolvable: false });
            decisions.push({ file, area, action: 'skip', reason: 'a different snapshot already holds that name' });
          }
          break;
        }

        case 'source_record': {
          const record = archiveRecords.get(area.id);
          if (!record || invalidRecordPaths.has(file.path)) {
            decisions.push({ file, area, action: 'skip', reason: 'not a valid source record' });
            break;
          }
          const existing = existingSources[area.id];
          if (!existing) {
            steps.push({ kind: 'write', path: file.path, content: file.content });
            preconditions.push({ path: file.path, sha256: null });
            importedSources.set(area.id, { record, rawPath: rawRelativePath(record.id, record.revision, record.mediaType) });
            decisions.push({ file, area, action: 'write' });
            applied.sources += 1;
            break;
          }
          if (recordExtends(existing, record)) {
            steps.push({ kind: 'write', path: file.path, content: file.content });
            preconditions.push({ path: file.path, sha256: existingSha });
            importedSources.set(area.id, { record, rawPath: manifest.sources[area.id]?.path ?? rawRelativePath(record.id, record.revision, record.mediaType) });
            decisions.push({ file, area, action: 'write' });
            applied.sources += 1;
            break;
          }
          conflicts.push({ area: 'source_record', path: file.path, id: area.id, reason: 'different_revision', existing: existing.revision, imported: record.revision, resolvable: false });
          decisions.push({ file, area, action: 'skip', reason: 'a different record already holds this source id' });
          break;
        }

        case 'source_extracted': {
          if (existingSha === null) {
            steps.push({ kind: 'write', path: file.path, content: file.content });
            preconditions.push({ path: file.path, sha256: null });
            decisions.push({ file, area, action: 'write' });
          } else {
            conflicts.push({ area: 'source_extracted', path: file.path, id: area.id, reason: 'different_bytes', existing: existingSha, imported: file.sha256, resolvable: false });
            decisions.push({ file, area, action: 'skip', reason: 'a different extraction already holds that name' });
          }
          break;
        }

        case 'raw': {
          const record = archiveRecords.get(area.id) ?? existingSources[area.id] ?? null;
          if (record && record.sha256 !== file.sha256) {
            warnings.push(`${file.path} does not match the checksum its source record declares; the original was not restored.`);
            decisions.push({ file, area, action: 'skip', reason: 'checksum does not match the source record' });
            break;
          }
          if (existingSha === null) {
            steps.push({ kind: 'write', path: file.path, content: file.content, encoding: 'base64' });
            preconditions.push({ path: file.path, sha256: null });
            const pending = importedSources.get(area.id);
            if (pending) pending.rawPath = file.path;
            decisions.push({ file, area, action: 'write' });
            applied.rawFiles += 1;
          } else {
            conflicts.push({ area: 'raw', path: file.path, id: area.id, reason: 'different_bytes', existing: existingSha, imported: file.sha256, resolvable: false });
            decisions.push({ file, area, action: 'skip', reason: 'a different original already holds that name' });
          }
          break;
        }

        case 'event': {
          const event = parseJson(file.content, LearningEventSchema);
          if (!event || event.id !== area.id) {
            warnings.push(`Ledger entry ${file.path} is not valid and will not be restored.`);
            decisions.push({ file, area, action: 'skip', reason: 'not a valid ledger entry' });
            break;
          }
          if (existingSha === null) {
            steps.push({ kind: 'write', path: file.path, content: file.content });
            preconditions.push({ path: file.path, sha256: null });
            decisions.push({ file, area, action: 'write' });
            applied.events += 1;
          } else {
            conflicts.push({ area: 'event', path: file.path, id: area.id, reason: 'different_bytes', existing: existingSha, imported: file.sha256, resolvable: false });
            decisions.push({ file, area, action: 'skip', reason: 'a different entry already holds that id' });
          }
          break;
        }

        case 'tombstone': {
          const tombstone = parseJson(file.content, SourceTombstoneSchema);
          if (!tombstone || tombstone.id !== area.id) {
            warnings.push(`Tombstone ${file.path} is not valid and will not be restored.`);
            decisions.push({ file, area, action: 'skip', reason: 'not a valid tombstone' });
            break;
          }
          if (existingSha === null) {
            steps.push({ kind: 'write', path: file.path, content: file.content });
            preconditions.push({ path: file.path, sha256: null });
            decisions.push({ file, area, action: 'write' });
            applied.tombstones += 1;
          } else {
            decisions.push({ file, area, action: 'skip', reason: 'an erasure marker already holds that id' });
          }
          break;
        }

        case 'log':
          break;
      }
    }

    // The learning log merges entry-wise: blocks the destination already has are not repeated.
    const logFile = archive.files.find((file) => classifyArchivePath(file.path)?.area === 'log');
    if (logFile) {
      const existingLog = (await readText(vaultPath(root, LOG_FILE))) ?? '';
      const importedBlocks: string[] = [];
      for (const block of logFile.content.split(/\n(?=## \[)/)) {
        const trimmed = block.trim();
        if (!trimmed.startsWith('## [')) continue;
        const entry = `${trimmed}\n`;
        if (existingLog.includes(entry) || importedBlocks.includes(entry)) continue;
        importedBlocks.push(entry);
      }
      for (const entry of importedBlocks) steps.push({ kind: 'append', path: LOG_FILE, content: entry });
      applied.logEntries += importedBlocks.length;
    }

    // The catalogue is rebuilt, never trusted from the archive: manifest and index describe
    // what the vault will hold after this journal, exactly as the keeper would write them.
    if (importedPageSnapshots.size > 0 || importedSources.size > 0) {
      const pages: Record<string, VaultManifestPage> = { ...manifest.pages };
      for (const id of overwrittenIds) delete pages[id];
      for (const [id, snapshot] of importedPageSnapshots) {
        if (snapshot.format === null) continue;
        pages[id] = {
          kind: snapshot.kind,
          revision: snapshot.revision,
          sha256: snapshot.fileSha256,
          bytes: snapshot.bytes,
          updatedAt: normalizeTimestamp(snapshot.metadata?.updatedAt ?? snapshot.legacy?.updated, at),
        };
      }
      const sources: Record<string, VaultManifestSource> = { ...manifest.sources };
      for (const [id, { record, rawPath }] of importedSources) {
        sources[id] = {
          revision: record.revision,
          mediaType: record.mediaType,
          sha256: record.sha256,
          bytes: record.bytes,
          createdAt: record.createdAt,
          path: rawPath,
          extractions: record.extractions.length,
        };
      }
      const entries: IndexEntry[] = [];
      for (const snapshot of existingPages.values()) {
        if (overwrittenIds.has(snapshot.id)) continue;
        const entry = indexEntryOf(snapshot);
        if (entry) entries.push(entry);
      }
      for (const snapshot of importedPageSnapshots.values()) {
        const entry = indexEntryOf(snapshot);
        if (entry) entries.push(entry);
      }
      steps.push(
        { kind: 'write', path: `${META_DIRECTORY}/${META_MANIFEST_FILE}`, content: `${JSON.stringify({ schemaVersion: VAULT_LAYOUT_VERSION, updatedAt: at, pages, sources }, null, 2)}\n` },
        { kind: 'write', path: INDEX_FILE, content: renderIndex(entries, at) },
      );
      preconditions.push(
        { path: `${META_DIRECTORY}/${META_MANIFEST_FILE}`, sha256: await shaOf(`${META_DIRECTORY}/${META_MANIFEST_FILE}`) },
        { path: INDEX_FILE, sha256: await shaOf(INDEX_FILE) },
      );
    }

    // The restore is itself a log line — after the merged blocks, so the timeline reads in order.
    const entry: BrainLogEntry = {
      at,
      kind: 'import',
      title: 'Restored a vault export',
      detail: `Exported by ${archive.exportedBy.studentId} at ${archive.createdAt}: ${applied.pages} page${applied.pages === 1 ? '' : 's'}, ${applied.sources} source${applied.sources === 1 ? '' : 's'}, ${applied.events} event${applied.events === 1 ? '' : 's'} applied; ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} left alone.`,
    };
    steps.push({ kind: 'append', path: LOG_FILE, content: renderLogEntry(entry) });
    // The log is appended to on every restore, so it is always part of what the lock re-checks.
    preconditions.push({ path: LOG_FILE, sha256: await shaOf(LOG_FILE) });

    const plan: VaultImportPlan = {
      writeFiles: decisions.filter((d) => d.action === 'write').length,
      bytes: decisions.filter((d) => d.action === 'write').reduce((total, d) => total + d.file.bytes, 0),
      createPages: [...importedPageSnapshots.keys()].filter((id) => !existingPages.has(id)),
      sources: { create: [], update: [], skip: [] },
      events: { create: applied.events, skip: 0 },
      history: { write: applied.history, skip: 0 },
      tombstones: { create: applied.tombstones, skip: 0 },
      logEntries: applied.logEntries,
      unchanged: decisions.filter((d) => d.action === 'unchanged').length,
    };
    const conflictedIds = new Set(conflicts.map((conflict) => conflict.id).filter((id): id is string => Boolean(id)));
    for (const [id] of importedSources) {
      if (existingSources[id]) plan.sources.update.push(id);
      else plan.sources.create.push(id);
    }
    for (const decision of decisions) {
      if (decision.action !== 'skip') continue;
      const area = decision.area;
      if ((area.area === 'source_record' || area.area === 'source_extracted' || area.area === 'raw') && 'id' in area && !conflictedIds.has(area.id)) {
        plan.sources.skip.push({ id: area.id, reason: decision.reason ?? 'skipped' });
      }
      if (area.area === 'event') plan.events.skip += 1;
      if (area.area === 'history') plan.history.skip += 1;
      if (area.area === 'tombstone') plan.tombstones.skip += 1;
    }

    return { steps, preconditions, decisions, conflicts, warnings, plan, applied };
  }
}

/** A record whose ledger only grew: same identity, same bytes, extractions extended — safe to adopt. */
function recordExtends(existing: SourceRecord, imported: SourceRecord): boolean {
  const sameCore =
    existing.id === imported.id &&
    existing.revision === imported.revision &&
    existing.kind === imported.kind &&
    existing.origin === imported.origin &&
    existing.sha256 === imported.sha256 &&
    existing.bytes === imported.bytes &&
    existing.mediaType === imported.mediaType &&
    existing.createdAt === imported.createdAt;
  if (!sameCore) return false;
  if (imported.extractions.length < existing.extractions.length) return false;
  return existing.extractions.every((entry, index) => JSON.stringify(entry) === JSON.stringify(imported.extractions[index]));
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

/** Every file under a directory, vault-relative — used for .history/ and orphan raw sweeps. */
async function walkFiles(directory: string, root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(absolute, root)));
    else if (entry.isFile()) out.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return out.sort();
}
