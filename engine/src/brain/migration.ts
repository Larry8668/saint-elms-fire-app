import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../config';
import { readText, writeFileAtomic } from '../lib/fs';
import { HISTORY_DIRECTORY, KIND_DIRECTORY, pageIdFromFileName, vaultPath } from './vault-layout';
import type { PageChange } from './wiki-plan';
import type { WikiStore } from './wiki-store';

export interface MigrationReport {
  migrated: PageChange[];
  /** Pages that already use the typed format. */
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  historyImported: number;
}

/**
 * Conservative, resumable adoption of an earlier concept vault. Each page is committed on its own,
 * so an interrupted migration leaves a mix of formats that both read back correctly and the next run
 * finishes. Nothing is upgraded by guesswork: sections become the student's own words, and the parts
 * of the old page whose provenance cannot be resolved are carried in the page's provenance block.
 */
export async function migrateLegacyVault(store: WikiStore): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], unchanged: [], skipped: [], historyImported: 0 };
  for (const snapshot of await store.listPages()) {
    if (snapshot.format === 2) {
      report.unchanged.push(snapshot.id);
      continue;
    }
    if (snapshot.format !== 1 || snapshot.state !== 'ok') {
      report.skipped.push({ id: snapshot.id, reason: snapshot.issue ?? 'the file is not an earlier-format concept page' });
      continue;
    }
    try {
      const change = await store.upgradeLegacyPage(snapshot.id);
      if (change) report.migrated.push(change);
    } catch (error) {
      report.skipped.push({ id: snapshot.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  report.historyImported = await importLegacyHistory(store.root);
  if (report.migrated.length || report.historyImported) {
    log.info('vault_legacy_migrated', { root: store.root, pages: report.migrated.length, history: report.historyImported, skipped: report.skipped.length });
  }
  return report;
}

/**
 * The earlier vault kept revisions in .history/<page-key>/<stamp>.md. They are copied into the
 * typed history folder under their original names and never overwritten, so nothing is lost or
 * renumbered; the originals stay where they are.
 */
export async function importLegacyHistory(root: string): Promise<number> {
  const legacyRoot = vaultPath(root, HISTORY_DIRECTORY);
  const reserved = new Set<string>(Object.values(KIND_DIRECTORY));
  let imported = 0;
  for (const entry of await readdir(legacyRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || reserved.has(entry.name)) continue;
    if (!pageIdFromFileName(`${entry.name}.md`)) {
      log.warn('vault_legacy_history_skipped', { root, entry: entry.name });
      continue;
    }
    const from = path.join(legacyRoot, entry.name);
    const to = vaultPath(root, HISTORY_DIRECTORY, KIND_DIRECTORY.concept, entry.name);
    await mkdir(to, { recursive: true });
    for (const file of await readdir(from, { withFileTypes: true }).catch(() => [])) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      if ((await readText(path.join(to, file.name))) !== null) continue;
      const content = await readText(path.join(from, file.name));
      if (content === null) continue;
      await writeFileAtomic(path.join(to, file.name), content);
      imported += 1;
    }
  }
  return imported;
}
