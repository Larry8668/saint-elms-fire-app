import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { errorFields, log } from '../config';
import { VaultLock } from '../brain/vault-lock';
import { VaultLockError } from '../brain/vault-errors';
import { readJson, writeFileAtomic, writeJson } from '../lib/fs';
import { sha256Hex } from '../lib/hash';
import { blobKey, syncManifestKey, vaultKey } from '../store/keys';
import { type ObjectStore, PreconditionFailedError } from '../store/object-store';
import { diffManifest, emptySyncManifest, nextManifest, referencedBlobs, type LocalEntry, type SyncEmbeddings, type SyncFile, type SyncManifest, SyncManifestSchema } from './manifest';
import { PushScheduler, type SchedulerOptions } from './scheduler';
import { EMBEDDINGS_DIRECTORY, mediaSourceId, scanProfile } from './scope';

import type { VaultSyncState } from '@sef/shared';

export type { VaultSyncState };

export interface VaultSyncOptions {
  store: ObjectStore;
  account: string;
  /** The profile root, ENGINE_DATA_DIR/profiles/<id>/. */
  root: string;
  now?: () => Date;
  scheduler?: SchedulerOptions;
  /** The embed model this engine would use, so a cache built by another model is skipped. Null: unknown. */
  embedModel?: () => Promise<string | null>;
  /** The vector cache is pushed at most this often (and always on the final flush). */
  embeddingsEveryMs?: number;
}

export interface PushResult {
  ok: true;
  /** Objects uploaded: changed files, new blobs, the embeddings pack. */
  pushed: number;
  deleted: number;
  version: number;
}

export interface RestoreReport {
  version: number;
  fetched: number;
  bytes: number;
  /** Media restored as a stub, fetched on first read. */
  lazy: number;
  removed: number;
  /** Objects newer than the manifest (a push cut off before its swap); kept, and pushed next. */
  rolledForward: number;
  embeddings: 'restored' | 'absent' | 'model_mismatch' | 'failed';
  ms: number;
}

export class SyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConflictError';
  }
}

interface StatCache {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** What this machine last agreed with the store. Kept beside the profile, never synced itself. */
interface LocalState {
  format: 1;
  account: string;
  etag: string | null;
  manifest: SyncManifest;
  stats: Record<string, StatCache>;
}

interface Snapshot {
  entries: Map<string, LocalEntry>;
  /** Text bytes read under the vault lock: exactly what is uploaded and named in the manifest. */
  bodies: Map<string, Buffer>;
}

export const SYNC_STATE_FILE = '.vault-sync.json';
const EMBEDDINGS_FILE = /^[a-z0-9_-]{1,64}\.json$/;
const CONCURRENCY = 6;

/**
 * Manifest-based sync of one student's profile to the object store (docs/object-store.md).
 * Restore once at boot; then push only what changed, with one compare-and-swap on the remote
 * manifest per push. A lost swap means a second writer exists: sync refuses, says so loudly,
 * and never merges.
 */
export class VaultSync {
  private stateValue: VaultSyncState = 'restoring';
  private restoredValue = false;
  private conflict: string | null = null;
  private base: SyncManifest;
  private etag: string | null = null;
  private stats: Record<string, StatCache> = {};
  private savedAt: Date | null = null;
  private lastError: string | null = null;
  private embeddingsDue = false;
  private embeddingsSignature: string | null = null;
  private embeddingsPushedAt = 0;
  private readonly fetching = new Map<string, Promise<boolean>>();
  private readonly scheduler: PushScheduler<PushResult>;
  private readonly now: () => Date;
  private readonly lock: VaultLock;
  readonly root: string;

  constructor(private readonly options: VaultSyncOptions) {
    this.root = path.resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.base = emptySyncManifest(options.account);
    this.lock = new VaultLock(path.join(this.root, 'brain'), { lockTimeoutMs: 10_000 });
    this.scheduler = new PushScheduler(() => this.push(), options.scheduler, () => {});
  }

  get state(): VaultSyncState {
    return this.stateValue;
  }

  /** True once a restore has completed: until then nothing may be served or pushed. */
  get restored(): boolean {
    return this.restoredValue;
  }

  status() {
    return { state: this.stateValue, savedAt: this.savedAt?.toISOString() ?? null, pending: this.scheduler.pending, version: this.base.version, error: this.lastError };
  }

  markDirty(): void {
    if (this.restoredValue && !this.conflict) this.scheduler.markDirty();
  }

  /** Restore, then keep pushing. Retries a failed restore a few times before giving up. */
  async start(attempts = 3, backoffMs = 2_000): Promise<RestoreReport | null> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const report = await this.restore();
        this.scheduler.start();
        return report;
      } catch (error) {
        log.error('vault_sync_restore_failed', { account: this.options.account, attempt, ...errorFields(error) });
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
    }
    return null;
  }

  stop(): void {
    this.scheduler.stop();
  }

  /** Pull the remote manifest and every text file that differs; media becomes a stub fetched on first read. */
  async restore(): Promise<RestoreReport> {
    const started = Date.now();
    this.stateValue = 'restoring';
    try {
      const saved = await this.loadState();
      const remote = await this.options.store.get(syncManifestKey(this.options.account));
      let manifest: SyncManifest;
      if (!remote) {
        // A store that forgot a vault this machine already synced is not a new account.
        if (saved?.etag) throw new Error(`The remote manifest for ${this.options.account} is missing, but this machine synced version ${saved.manifest.version}.`);
        manifest = emptySyncManifest(this.options.account);
      } else {
        manifest = SyncManifestSchema.parse(JSON.parse(Buffer.from(remote.body).toString('utf8')));
        if (manifest.account !== this.options.account) throw new Error('The remote manifest names a different account.');
      }
      this.stats = saved?.stats ?? {};
      const local = await this.hashLocal();
      const report: RestoreReport = { version: manifest.version, fetched: 0, bytes: 0, lazy: 0, removed: 0, rolledForward: 0, embeddings: 'absent', ms: 0 };
      // The remote is still what this machine last pushed (an engine restart): what is on disk
      // is newer, so nothing is pulled, and the next push carries any edits made since.
      const unchanged = saved !== null && remote !== null && saved.etag === remote.etag;
      if (unchanged) return this.finishRestore(manifest, remote.etag, report, started);

      const keptEdits: string[] = [];
      for (const [relPath, tombstone] of Object.entries(manifest.tombstones)) {
        const here = local.get(relPath);
        if (manifest.files[relPath] || !here) continue;
        // Delete only the version that was deleted, or one this machine never edited. An edit made
        // here and never pushed is kept (and pushed back), so a delete elsewhere cannot eat it.
        if (here.sha256 !== tombstone.sha256 && saved?.manifest.files[relPath]?.sha256 !== here.sha256) {
          keptEdits.push(relPath);
          continue;
        }
        await rm(this.abs(relPath), { force: true });
        delete this.stats[relPath];
        report.removed += 1;
      }
      if (keptEdits.length) log.warn('vault_sync_tombstone_skipped_local_edit', { account: this.options.account, files: keptEdits.length, sample: keptEdits.slice(0, 5) });
      const fetches: Array<() => Promise<void>> = [];
      const replaced: string[] = [];
      for (const [relPath, file] of Object.entries(manifest.files)) {
        const here = local.get(relPath);
        if (here?.sha256 === file.sha256) continue;
        // Edited here after this machine's last push, then superseded by another machine's push.
        if (saved && here && saved.manifest.files[relPath]?.sha256 !== here.sha256) replaced.push(relPath);
        if (file.kind === 'media') {
          // Media is immutable: a stale local copy is dropped and the right one fetched when read.
          if (local.has(relPath)) await rm(this.abs(relPath), { force: true });
          delete this.stats[relPath];
          report.lazy += 1;
          continue;
        }
        fetches.push(async () => {
          const bytes = await this.download(relPath, file);
          if (sha256Hex(bytes) !== file.sha256) report.rolledForward += 1;
          report.fetched += 1;
          report.bytes += bytes.byteLength;
        });
      }
      await pool(fetches, CONCURRENCY);
      if (replaced.length) log.warn('vault_sync_local_edits_replaced', { account: this.options.account, files: replaced.length, sample: replaced.slice(0, 5) });
      report.embeddings = await this.restoreEmbeddings(manifest.embeddings);
      return await this.finishRestore(manifest, remote?.etag ?? null, report, started);
    } catch (error) {
      this.stateValue = 'error';
      this.lastError = 'restore_failed';
      throw error;
    }
  }

  private async finishRestore(manifest: SyncManifest, etag: string | null, report: RestoreReport, started: number): Promise<RestoreReport> {
    this.base = manifest;
    this.etag = etag;
    await this.saveState();
    report.ms = Date.now() - started;
    this.restoredValue = true;
    this.stateValue = 'ready';
    this.savedAt = this.now();
    if (report.rolledForward) log.warn('vault_sync_rolled_forward', { account: this.options.account, files: report.rolledForward });
    log.info('vault_sync_restored', { account: this.options.account, ...report });
    return report;
  }

  /** The final flush: everything, the vector cache included, after any push in flight. */
  flush(): Promise<PushResult> {
    if (!this.restoredValue) return Promise.reject(new Error('Vault sync has not restored yet; refusing to push over the remote vault.'));
    this.embeddingsDue = true;
    return this.scheduler.run();
  }

  async push(): Promise<PushResult> {
    if (!this.restoredValue) throw new Error('Vault sync has not restored yet.');
    if (this.conflict) throw new SyncConflictError(this.conflict);
    try {
      const result = await this.pushOnce();
      this.stateValue = 'ready';
      this.lastError = null;
      this.savedAt = this.now();
      return result;
    } catch (error) {
      if (error instanceof VaultLockError) {
        // A long vault operation holds the lock: not a failure, just later.
        this.scheduler.markDirty();
        throw error;
      }
      this.stateValue = 'error';
      if (error instanceof SyncConflictError) {
        this.conflict = error.message;
        this.lastError = 'conflict';
        this.scheduler.stop();
        log.error('vault_sync_conflict', { account: this.options.account, version: this.base.version, error: error.message });
      } else {
        this.lastError = 'push_failed';
        log.error('vault_sync_push_failed', { account: this.options.account, ...errorFields(error) });
      }
      throw error;
    }
  }

  private async pushOnce(): Promise<PushResult> {
    const { store, account } = this.options;
    const snapshot = await this.snapshot();
    const lazy = this.lazyMedia(snapshot.entries);
    const diff = diffManifest(this.base, snapshot.entries, await lazy);
    const embeddings = await this.embeddingsPack();
    if (!diff.upload.length && !diff.deleted.length && !embeddings) return { ok: true, pushed: 0, deleted: 0, version: this.base.version };

    // Cheap early refusal: someone else moved the manifest since our last swap.
    const head = await store.head(syncManifestKey(account));
    if ((head?.etag ?? null) !== this.etag) throw new SyncConflictError(`The remote manifest moved since version ${this.base.version}; another writer holds this vault.`);

    let pushed = 0;
    await pool(
      diff.upload.map((relPath) => async () => {
        const entry = snapshot.entries.get(relPath)!;
        if (entry.kind === 'text') {
          await store.put(vaultKey(account, relPath), snapshot.bodies.get(relPath)!, { contentType: contentType(relPath) });
          pushed += 1;
          return;
        }
        // Raw files are immutable, but re-hash what is actually sent: the manifest must name these bytes.
        const bytes = await readFile(this.abs(relPath));
        entry.sha256 = sha256Hex(bytes);
        entry.size = bytes.byteLength;
        if (await this.putBlob(entry.sha256, bytes)) pushed += 1;
      }),
      CONCURRENCY,
    );
    if (embeddings && (await this.putBlob(embeddings.meta.sha256, embeddings.body))) pushed += 1;

    const next = nextManifest(this.base, snapshot.entries, await lazy, diff, this.now());
    if (embeddings) next.embeddings = embeddings.meta;
    let etag: string;
    try {
      ({ etag } = await store.put(syncManifestKey(account), `${JSON.stringify(next)}\n`, {
        contentType: 'application/json',
        ...(this.etag ? { ifMatch: this.etag } : { ifNoneMatch: '*' as const }),
      }));
    } catch (error) {
      if (error instanceof PreconditionFailedError) throw new SyncConflictError(`Lost the manifest swap at version ${next.version}; another writer holds this vault.`);
      throw error;
    }
    const previous = this.base;
    this.base = next;
    this.etag = etag;
    if (embeddings) {
      this.embeddingsSignature = embeddings.signature;
      this.embeddingsPushedAt = Date.now();
    }
    await this.saveState();
    const deleted = await this.collectGarbage(previous, next);
    log.info('vault_sync_pushed', { account, version: next.version, pushed, deleted });
    return { ok: true, pushed, deleted, version: next.version };
  }

  /** Only after the swap: an object the new manifest no longer names is removed (erasure means erasure). */
  private async collectGarbage(previous: SyncManifest, next: SyncManifest): Promise<number> {
    const { store, account } = this.options;
    const stillNeeded = referencedBlobs(next);
    const doomed = [
      // Deleted, or grown into a blob: either way files/<path> no longer holds a live version.
      ...Object.entries(previous.files)
        .filter(([relPath, file]) => file.kind === 'text' && next.files[relPath]?.kind !== 'text')
        .map(([relPath]) => vaultKey(account, relPath)),
      ...[...referencedBlobs(previous)].filter((sha) => !stillNeeded.has(sha)).map((sha) => blobKey(account, sha)),
    ];
    let deleted = 0;
    await pool(
      doomed.map((key) => async () => {
        try {
          await store.delete(key);
          deleted += 1;
        } catch (error) {
          log.warn('vault_sync_delete_failed', { key, ...errorFields(error) });
        }
      }),
      CONCURRENCY,
    );
    return deleted;
  }

  /** Content-addressed and immutable: a blob already there is never sent again. */
  private async putBlob(sha256: string, bytes: Uint8Array): Promise<boolean> {
    const key = blobKey(this.options.account, sha256);
    if (await this.options.store.head(key)) return false;
    try {
      await this.options.store.put(key, bytes, { ifNoneMatch: '*' });
      return true;
    } catch (error) {
      if (error instanceof PreconditionFailedError) return false;
      throw error;
    }
  }

  private async download(relPath: string, file: SyncFile): Promise<Buffer> {
    const key = file.kind === 'text' ? vaultKey(this.options.account, relPath) : blobKey(this.options.account, file.sha256);
    const object = await this.options.store.get(key);
    if (!object) throw new Error(`The manifest names ${relPath}, but its object is missing.`);
    const bytes = Buffer.from(object.body);
    // A blob's key is its hash, so a mismatch is corruption. A text object newer than the
    // manifest is what a push cut off between its uploads and its swap leaves: keep it.
    if (file.kind !== 'text' && sha256Hex(bytes) !== file.sha256) throw new Error(`Blob for ${relPath} does not match its hash.`);
    await writeFileAtomic(this.abs(relPath), bytes);
    const info = await stat(this.abs(relPath));
    this.stats[relPath] = { size: info.size, mtimeMs: info.mtimeMs, sha256: file.sha256 };
    if (file.kind === 'text' && sha256Hex(bytes) !== file.sha256) this.stats[relPath]!.sha256 = sha256Hex(bytes);
    return bytes;
  }

  /** Fetch-on-miss for a media stub. False when the path is not a stub this sync knows. */
  async materialize(absolutePath: string): Promise<boolean> {
    const relPath = path.relative(this.root, path.resolve(absolutePath)).split(path.sep).join('/');
    const file = this.base.files[relPath];
    if (!this.restoredValue || !file || file.kind !== 'media') return false;
    if (await exists(this.abs(relPath))) return true;
    // Erased here but not pushed yet: never bring it back.
    if (await this.erasedHere(relPath)) return false;
    let pending = this.fetching.get(relPath);
    if (!pending) {
      const started = Date.now();
      pending = this.download(relPath, file)
        .then((bytes) => {
          log.info('vault_sync_media_fetched', { path: relPath, bytes: bytes.byteLength, ms: Date.now() - started });
          return true;
        })
        .finally(() => this.fetching.delete(relPath));
      this.fetching.set(relPath, pending);
    }
    return pending;
  }

  async materializeAll(absoluteDirectory: string): Promise<void> {
    const prefix = path.relative(this.root, path.resolve(absoluteDirectory)).split(path.sep).join('/');
    const wanted = Object.entries(this.base.files).filter(([relPath, file]) => file.kind === 'media' && (prefix === '' || relPath.startsWith(`${prefix}/`)));
    await pool(wanted.map(([relPath]) => async () => void (await this.materialize(this.abs(relPath)))), CONCURRENCY);
  }

  /**
   * Media in the base that is not on disk is a stub, not a delete, unless the student erased
   * its source here: erasure leaves a vault tombstone and removes the source record.
   */
  private async lazyMedia(local: ReadonlyMap<string, LocalEntry>): Promise<Set<string>> {
    const lazy = new Set<string>();
    for (const [relPath, file] of Object.entries(this.base.files)) {
      if (file.kind !== 'media' || local.has(relPath)) continue;
      if (!(await this.erasedHere(relPath))) lazy.add(relPath);
    }
    return lazy;
  }

  private async erasedHere(relPath: string): Promise<boolean> {
    const id = mediaSourceId(relPath);
    return id !== null && (await exists(this.abs(`brain/.meta/tombstones/${id}.json`))) && !(await exists(this.abs(`brain/.meta/sources/${id}.json`)));
  }

  /**
   * Every synced file with its hash, rereading only what changed size or mtime since the last
   * look. With `bodies`, text that differs from the base is kept in memory for the upload, and
   * binaries are left unhashed (`sha256: ''`) so the caller can hash them outside the vault lock.
   */
  private async hashLocal(bodies?: Map<string, Buffer>): Promise<Map<string, LocalEntry>> {
    const entries = new Map<string, LocalEntry>();
    const next: Record<string, StatCache> = {};
    for (const file of (await scanProfile(this.root)).values()) {
      const cached = this.stats[file.relPath];
      let sha256 = cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs ? cached.sha256 : null;
      if (file.kind === 'text') {
        const known = this.base.files[file.relPath];
        const changed = sha256 === null || !known || known.sha256 !== sha256 || known.kind !== 'text';
        if (sha256 === null || (bodies && changed)) {
          const bytes = await readFile(this.abs(file.relPath)).catch(() => null);
          if (!bytes) continue;
          sha256 = sha256Hex(bytes);
          if (bodies) bodies.set(file.relPath, bytes);
        }
      } else if (sha256 === null && !bodies) {
        const bytes = await readFile(this.abs(file.relPath)).catch(() => null);
        if (!bytes) continue;
        sha256 = sha256Hex(bytes);
      }
      if (sha256) next[file.relPath] = { size: file.size, mtimeMs: file.mtimeMs, sha256 };
      entries.set(file.relPath, { sha256: sha256 ?? '', size: file.size, mtime: Math.floor(file.mtimeMs), kind: file.kind });
    }
    this.stats = next;
    return entries;
  }

  /** Text is read under the vault lock, so pages and their catalogue are one moment; binaries after. */
  private async snapshot(): Promise<Snapshot> {
    const bodies = new Map<string, Buffer>();
    const entries = await this.lock.run(() => this.hashLocal(bodies));
    for (const [relPath, entry] of entries) {
      if (entry.sha256) continue;
      const bytes = await readFile(this.abs(relPath)).catch(() => null);
      if (!bytes) {
        entries.delete(relPath);
        continue;
      }
      const info = await stat(this.abs(relPath)).catch(() => null);
      entry.sha256 = sha256Hex(bytes);
      if (info) this.stats[relPath] = { size: info.size, mtimeMs: info.mtimeMs, sha256: entry.sha256 };
    }
    return { entries, bodies };
  }

  private async embeddingsPack(): Promise<{ meta: SyncEmbeddings; body: Buffer; signature: string } | null> {
    const due = this.embeddingsDue || Date.now() - this.embeddingsPushedAt >= (this.options.embeddingsEveryMs ?? 10 * 60_000);
    this.embeddingsDue = false;
    if (!due) return null;
    const directory = this.abs(EMBEDDINGS_DIRECTORY);
    const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => EMBEDDINGS_FILE.test(name)).sort();
    if (!names.length) return null;
    const files: Record<string, string> = {};
    const models = new Set<string>();
    const signatureParts: string[] = [];
    for (const name of names) {
      const text = await readFile(path.join(directory, name), 'utf8').catch(() => null);
      if (text === null) continue;
      files[name] = text;
      signatureParts.push(`${name}:${sha256Hex(text)}`);
      try {
        const model = (JSON.parse(text) as { model?: unknown }).model;
        if (typeof model === 'string') models.add(model);
      } catch {
        // A corrupt index file is still carried; the reader drops it and rebuilds.
      }
    }
    const signature = signatureParts.join('|');
    if (signature === this.embeddingsSignature) return null;
    const body = gzipSync(JSON.stringify({ format: 1, files }));
    const meta: SyncEmbeddings = { sha256: sha256Hex(body), size: body.byteLength, models: [...models].sort(), updatedAt: this.now().toISOString() };
    return { meta, body, signature };
  }

  /** Optional and derived: any failure here costs a rebuild, never the restore. */
  private async restoreEmbeddings(meta: SyncEmbeddings | undefined): Promise<RestoreReport['embeddings']> {
    if (!meta) return 'absent';
    try {
      const expected = (await this.options.embedModel?.()) ?? null;
      if (expected !== null && meta.models.some((model) => model !== expected)) return 'model_mismatch';
      const object = await this.options.store.get(blobKey(this.options.account, meta.sha256));
      if (!object || sha256Hex(object.body) !== meta.sha256) return 'failed';
      const pack = JSON.parse(gunzipSync(object.body).toString('utf8')) as { format?: unknown; files?: Record<string, unknown> };
      if (pack.format !== 1 || typeof pack.files !== 'object' || pack.files === null) return 'failed';
      const parts: string[] = [];
      for (const [name, text] of Object.entries(pack.files).sort(([a], [b]) => a.localeCompare(b))) {
        if (!EMBEDDINGS_FILE.test(name) || typeof text !== 'string') continue;
        await writeFileAtomic(path.join(this.abs(EMBEDDINGS_DIRECTORY), name), text);
        parts.push(`${name}:${sha256Hex(text)}`);
      }
      this.embeddingsSignature = parts.join('|');
      this.embeddingsPushedAt = Date.now();
      return 'restored';
    } catch (error) {
      log.warn('vault_sync_embeddings_restore_failed', errorFields(error));
      return 'failed';
    }
  }

  private abs(relPath: string): string {
    return path.join(this.root, ...relPath.split('/'));
  }

  private async loadState(): Promise<LocalState | null> {
    const state = await readJson<LocalState | null>(path.join(this.root, SYNC_STATE_FILE), null).catch(() => null);
    if (!state || state.format !== 1 || state.account !== this.options.account) return null;
    const manifest = SyncManifestSchema.safeParse(state.manifest);
    return manifest.success ? { ...state, manifest: manifest.data, stats: state.stats ?? {} } : null;
  }

  private async saveState(): Promise<void> {
    const state: LocalState = { format: 1, account: this.options.account, etag: this.etag, manifest: this.base, stats: this.stats };
    await writeJson(path.join(this.root, SYNC_STATE_FILE), state);
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function contentType(relPath: string): string {
  if (relPath.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (relPath.endsWith('.json')) return 'application/json';
  if (relPath.endsWith('.txt') || relPath.endsWith('.jsonl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Runs tasks with at most `limit` in flight; the first failure rejects after the rest settle. */
async function pool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      try {
        await task();
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure) throw failure;
}
