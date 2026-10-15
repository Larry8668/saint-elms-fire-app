import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { log, errorFields } from '../config';
import { readText, writeFileAtomic, writeJson } from '../lib/fs';
import { VaultPathError } from './vault-errors';
import { META_DIRECTORY, META_JOURNAL_DIRECTORY, META_RECOVERY_DIRECTORY, assertRelativeVaultPath, vaultPath } from './vault-layout';

export const JOURNAL_SCHEMA_VERSION = 2 as const;

/**
 * A step is a complete instruction, never a patch: recovery replays steps by writing the whole
 * file again, so replaying a journal twice lands on the same bytes as replaying it once.
 */
export const JournalStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('write'), path: z.string().min(1), content: z.string() }),
  z.strictObject({ kind: z.literal('append'), path: z.string().min(1), content: z.string().min(1) }),
  z.strictObject({ kind: z.literal('remove'), path: z.string().min(1) }),
]);
export type JournalStep = z.infer<typeof JournalStepSchema>;

export const JournalRecordSchema = z.strictObject({
  schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
  id: z.string().min(1).max(128),
  intent: z.string().min(1).max(200),
  createdAt: z.string().min(1),
  steps: z.array(JournalStepSchema).min(1),
});
export type JournalRecord = z.infer<typeof JournalRecordSchema>;

export interface RecoveryReport {
  recovered: { id: string; intent: string; steps: number; paths: string[] }[];
  invalid: { file: string; reason: string }[];
}

export interface RecoveryRecord {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  journalId: string;
  intent: string;
  recoveredAt: string;
  paths: string[];
  state: 'recovered';
}

export function journalDirectory(root: string): string {
  return vaultPath(root, META_DIRECTORY, META_JOURNAL_DIRECTORY);
}

/**
 * Write-ahead: the journal lands before the first target file, so a crash either leaves no trace
 * (the commit never started) or a journal that recovery can finish.
 */
export async function beginJournal(root: string, intent: string, steps: JournalStep[]): Promise<JournalRecord> {
  if (!steps.length) throw new VaultPathError('A commit needs at least one step');
  const record: JournalRecord = JournalRecordSchema.parse({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: randomUUID(),
    intent,
    createdAt: new Date().toISOString(),
    steps: steps.map((step) => ({ ...step, path: assertRelativeVaultPath(step.path) })),
  });
  await writeJson(journalPath(root, record.id), record);
  return record;
}

export async function completeJournal(root: string, id: string): Promise<void> {
  await rm(journalPath(root, id), { force: true });
}

export async function applyJournalSteps(root: string, steps: JournalStep[]): Promise<string[]> {
  const applied: string[] = [];
  for (const step of steps) {
    const relativePath = assertRelativeVaultPath(step.path);
    const target = vaultPath(root, relativePath);
    if (step.kind === 'write') {
      await writeFileAtomic(target, step.content);
    } else if (step.kind === 'append') {
      await appendOnce(target, step.content);
    } else {
      await rm(target, { force: true });
    }
    applied.push(relativePath);
  }
  return applied;
}

export async function recoverJournals(root: string, at: string): Promise<RecoveryReport> {
  const report: RecoveryReport = { recovered: [], invalid: [] };
  for (const file of await listJournalFiles(root)) {
    const raw = await readText(path.join(journalDirectory(root), file));
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      report.invalid.push({ file, reason: 'journal is not valid JSON' });
      continue;
    }
    const record = JournalRecordSchema.safeParse(parsed);
    if (!record.success) {
      report.invalid.push({ file, reason: 'journal does not match the journal schema' });
      continue;
    }
    let paths: string[];
    try {
      paths = await applyJournalSteps(root, record.data.steps);
    } catch (error) {
      // One unreadable journal must not block the others, and must not be deleted as if it were replayed.
      report.invalid.push({ file, reason: error instanceof Error ? error.message : String(error) });
      log.error('vault_journal_unrecoverable', { root, journal: record.data.id, ...errorFields(error) });
      continue;
    }
    const recovery: RecoveryRecord = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      journalId: record.data.id,
      intent: record.data.intent,
      recoveredAt: at,
      paths,
      state: 'recovered',
    };
    await writeJson(vaultPath(root, META_DIRECTORY, META_RECOVERY_DIRECTORY, `${record.data.id}.json`), recovery);
    await completeJournal(root, record.data.id);
    report.recovered.push({ id: record.data.id, intent: record.data.intent, steps: record.data.steps.length, paths });
    log.warn('vault_commit_recovered', { root, journal: record.data.id, intent: record.data.intent, steps: record.data.steps.length });
  }
  return report;
}

/** Append unless the exact entry is already there: a replayed append must not duplicate lines. */
async function appendOnce(target: string, content: string): Promise<void> {
  const existing = await readText(target);
  if (existing === null) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, content);
    return;
  }
  if (existing.includes(content)) return;
  await appendFile(target, existing.endsWith('\n') ? content : `\n${content}`);
}

async function listJournalFiles(root: string): Promise<string[]> {
  const files = await readdir(journalDirectory(root)).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith('.json')).sort();
}

/** Commits that were interrupted: still on disk, waiting for recovery. */
export async function pendingJournals(root: string): Promise<string[]> {
  return listJournalFiles(root);
}

function journalPath(root: string, id: string): string {
  return vaultPath(root, META_DIRECTORY, META_JOURNAL_DIRECTORY, `${id}.json`);
}
