import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { DeviceProfile } from '@sef/shared';
import { config, type ProfilePaths } from '../config';
import { readJson, writeFileAtomic, writeJson } from '../lib/fs';

export const ANONYMOUS_DATA_CATEGORIES = ['content', 'brain', 'sessions', 'quizzes'] as const;
type AnonymousCategory = (typeof ANONYMOUS_DATA_CATEGORIES)[number];

interface ScannedFile {
  relativePath: string;
  bytes: number;
}

export interface AnonymousCategoryPreview {
  name: AnonymousCategory;
  files: number;
  bytes: number;
}

export interface AnonymousPreview {
  available: boolean;
  claimed: boolean;
  claimComplete: boolean;
  categories: AnonymousCategoryPreview[];
  fileCount: number;
  totalBytes: number;
}

interface AnonymousBackupManifest {
  version: 1;
  id: string;
  createdAt: string;
  categories: AnonymousCategoryPreview[];
  fileCount: number;
  totalBytes: number;
}

interface ClaimState {
  backupId: string;
  profileId: string;
  claimedAt: string;
  completed: boolean;
  importedFiles: number;
  skippedFiles: number;
}

export class AnonymousDataClaimedError extends Error {
  constructor(message = 'Anonymous data has already been claimed by another profile.') {
    super(message);
  }
}

export class AnonymousDataBackupError extends Error {}

/** Explicit, non-destructive import of the pre-profile student folders at the engine data root. */
export class AnonymousDataManager {
  private claimQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataRoot = config.paths.data) {}

  private get backupRoot() {
    return path.join(this.dataRoot, 'anonymous-backups');
  }

  private get claimFile() {
    return path.join(this.dataRoot, 'anonymous-claim.json');
  }

  private async scan(): Promise<Map<AnonymousCategory, ScannedFile[]>> {
    const categories = new Map<AnonymousCategory, ScannedFile[]>();
    for (const category of ANONYMOUS_DATA_CATEGORIES) {
      categories.set(category, await scanDirectory(path.join(this.dataRoot, category)));
    }
    return categories;
  }

  async preview(): Promise<AnonymousPreview> {
    const [filesByCategory, claim] = await Promise.all([
      this.scan(),
      readJson<ClaimState | null>(this.claimFile, null),
    ]);
    const categories = summarize(filesByCategory);
    const fileCount = categories.reduce((sum, category) => sum + category.files, 0);
    const totalBytes = categories.reduce((sum, category) => sum + category.bytes, 0);
    return {
      available: fileCount > 0,
      claimed: Boolean(claim),
      claimComplete: Boolean(claim?.completed),
      categories,
      fileCount,
      totalBytes,
    };
  }

  async backup(): Promise<Omit<AnonymousBackupManifest, 'version'>> {
    const filesByCategory = await this.scan();
    const categories = summarize(filesByCategory);
    const fileCount = categories.reduce((sum, category) => sum + category.files, 0);
    const totalBytes = categories.reduce((sum, category) => sum + category.bytes, 0);
    if (!fileCount) throw new AnonymousDataBackupError('No anonymous student data is available to back up.');

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const directory = path.join(this.backupRoot, id);
    await mkdir(directory, { recursive: true });
    try {
      for (const category of ANONYMOUS_DATA_CATEGORIES) {
        const source = path.join(this.dataRoot, category);
        const target = path.join(directory, category);
        for (const file of filesByCategory.get(category) ?? []) {
          await copyNewFile(source, target, file.relativePath);
        }
      }
      const manifest: AnonymousBackupManifest = { version: 1, id, createdAt, categories, fileCount, totalBytes };
      await writeJson(path.join(directory, 'manifest.json'), manifest);
      return { id, createdAt, categories, fileCount, totalBytes };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async claim(profile: DeviceProfile, paths: ProfilePaths, backupId: string) {
    return this.withClaimLock(async () => {
      if (!isUuid(backupId)) throw new AnonymousDataBackupError('A valid anonymous-data backup is required before claiming.');
      const backupDir = path.join(this.backupRoot, backupId);
      const manifest = await readJson<AnonymousBackupManifest | null>(path.join(backupDir, 'manifest.json'), null);
      if (!manifest || manifest.version !== 1 || manifest.id !== backupId || manifest.fileCount < 1) {
        throw new AnonymousDataBackupError('Anonymous-data backup was not found or is invalid. Create a new backup and try again.');
      }

      let claim = await readJson<ClaimState | null>(this.claimFile, null);
      if (claim && (claim.profileId !== profile.id || claim.backupId !== backupId)) {
        throw new AnonymousDataClaimedError();
      }
      if (claim?.completed) return { ...claim, alreadyClaimed: true };

      if (!claim) {
        claim = {
          backupId,
          profileId: profile.id,
          claimedAt: new Date().toISOString(),
          completed: false,
          importedFiles: 0,
          skippedFiles: 0,
        };
        await writeJson(this.claimFile, claim);
      }

      let importedFiles = 0;
      let skippedFiles = 0;
      for (const category of ANONYMOUS_DATA_CATEGORIES) {
        const source = path.join(backupDir, category);
        const target = paths[category];
        const files = await scanDirectory(source);
        for (const file of files) {
          if (category === 'brain' && file.relativePath === 'SCHEMA.md') {
            skippedFiles += 1;
            continue;
          }
          if (category === 'brain' && file.relativePath === 'log.md') {
            const result = await mergeLog(source, target, file.relativePath);
            if (result === 'copied') importedFiles += 1;
            else skippedFiles += 1;
            continue;
          }
          const result = await copyIfAbsent(source, target, file.relativePath);
          if (result === 'copied') importedFiles += 1;
          else skippedFiles += 1;
        }
      }

      claim = { ...claim, completed: true, importedFiles, skippedFiles };
      await writeJson(this.claimFile, claim);
      return { ...claim, alreadyClaimed: false };
    });
  }

  private async withClaimLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.claimQueue;
    let release!: () => void;
    this.claimQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function scanDirectory(root: string): Promise<ScannedFile[]> {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return [];

  const found: ScannedFile[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const fileInfo = await lstat(fullPath);
        if (fileInfo.isFile() && !fileInfo.isSymbolicLink()) {
          found.push({ relativePath: path.relative(root, fullPath), bytes: fileInfo.size });
        }
      }
    }
  };
  await walk(root);
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function summarize(filesByCategory: Map<AnonymousCategory, ScannedFile[]>): AnonymousCategoryPreview[] {
  return ANONYMOUS_DATA_CATEGORIES.map((name) => {
    const files = filesByCategory.get(name) ?? [];
    return { name, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  });
}

async function copyNewFile(sourceRoot: string, targetRoot: string, relativePath: string): Promise<void> {
  validateRelativePath(relativePath);
  const source = path.resolve(sourceRoot, relativePath);
  const target = path.resolve(targetRoot, relativePath);
  if (!source.startsWith(path.resolve(sourceRoot) + path.sep) || !target.startsWith(path.resolve(targetRoot) + path.sep)) {
    throw new Error('Refusing to copy an anonymous-data file outside its workspace.');
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
}

async function copyIfAbsent(sourceRoot: string, targetRoot: string, relativePath: string): Promise<'copied' | 'skipped'> {
  try {
    await copyNewFile(sourceRoot, targetRoot, relativePath);
    return 'copied';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'skipped';
    throw error;
  }
}

async function mergeLog(sourceRoot: string, targetRoot: string, relativePath: string): Promise<'copied' | 'skipped'> {
  validateRelativePath(relativePath);
  const source = path.resolve(sourceRoot, relativePath);
  const target = path.resolve(targetRoot, relativePath);
  if (!source.startsWith(path.resolve(sourceRoot) + path.sep) || !target.startsWith(path.resolve(targetRoot) + path.sep)) {
    throw new Error('Refusing to copy an anonymous-data log outside its workspace.');
  }
  const sourceContent = await readFile(source, 'utf8');
  let targetContent: string;
  try {
    targetContent = await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await copyNewFile(sourceRoot, targetRoot, relativePath);
    return 'copied';
  }
  const legacyBody = sourceContent.replace(/^# Learning log\s*/m, '').trim();
  if (!legacyBody || targetContent.includes(legacyBody)) return 'skipped';
  await writeFileAtomic(target, `${targetContent.trimEnd()}\n\n${legacyBody}\n`);
  return 'copied';
}

function validateRelativePath(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
    throw new Error('Refusing an invalid anonymous-data file path.');
  }
}

