import type { VaultExport } from '@sef/shared';
import { api } from './api';

export const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

/** The student's whole vault as one downloaded JSON file; the export comes back for the caller's notice. */
export async function downloadVaultExport(): Promise<VaultExport> {
  const exported = await api.exportVault();
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `sef-vault-${exported.createdAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  return exported;
}

/** What a finished export did, in one sentence — shared by the settings panel and the limited-access screen. */
export const exportNotice = (exported: VaultExport): string =>
  `Exported ${exported.counts.files} files (${formatBytes(exported.counts.bytes)})${
    exported.skipped.length ? ` — ${exported.skipped.length} path${exported.skipped.length === 1 ? '' : 's'} left out and listed inside the file` : ''
  }.`;
