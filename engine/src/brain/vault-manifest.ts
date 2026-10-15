import { z } from 'zod';
import { RevisionSchema, Sha256Schema, TimestampSchema } from '@sef/shared';
import { readText } from '../lib/fs';
import { VaultIntegrityError, VaultSchemaError } from './vault-errors';
import { META_DIRECTORY, META_MANIFEST_FILE, PageKindSchema, VAULT_LAYOUT_VERSION, vaultPath } from './vault-layout';

/**
 * The manifest is the vault's own catalogue: it records the committed revision of every page and
 * source, which is what lets the keeper notice an edit made outside it (including a whitespace-only
 * one that leaves the page's semantic revision unchanged).
 */
export const VaultManifestPageSchema = z.strictObject({
  kind: PageKindSchema,
  revision: RevisionSchema,
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
});

export const VaultManifestSourceSchema = z.strictObject({
  revision: RevisionSchema,
  mediaType: z.string().min(1).max(120),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  path: z.string().min(1),
  extractions: z.number().int().nonnegative(),
});

export const VaultManifestSchema = z.strictObject({
  schemaVersion: z.literal(VAULT_LAYOUT_VERSION),
  updatedAt: TimestampSchema,
  pages: z.record(z.string(), VaultManifestPageSchema),
  sources: z.record(z.string(), VaultManifestSourceSchema),
});
export type VaultManifest = z.infer<typeof VaultManifestSchema>;
export type VaultManifestPage = z.infer<typeof VaultManifestPageSchema>;
export type VaultManifestSource = z.infer<typeof VaultManifestSourceSchema>;

export type ManifestIntegrity = 'ok' | 'missing' | 'invalid' | 'newer_schema';

export interface ManifestRead {
  manifest: VaultManifest | null;
  integrity: ManifestIntegrity;
}

export function emptyManifest(at: string): VaultManifest {
  return { schemaVersion: VAULT_LAYOUT_VERSION, updatedAt: at, pages: {}, sources: {} };
}

export function manifestPath(root: string): string {
  return vaultPath(root, META_DIRECTORY, META_MANIFEST_FILE);
}

/**
 * Reads tolerate anything: a missing or newer manifest must not blind the reader. Writes go
 * through assertWritableManifest, which refuses to downgrade a manifest it cannot understand.
 */
export async function readManifest(root: string): Promise<ManifestRead> {
  const raw = await readText(manifestPath(root));
  if (raw === null) return { manifest: null, integrity: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { manifest: null, integrity: 'invalid' };
  }
  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && version > VAULT_LAYOUT_VERSION) return { manifest: null, integrity: 'newer_schema' };
  const manifest = VaultManifestSchema.safeParse(parsed);
  return manifest.success ? { manifest: manifest.data, integrity: 'ok' } : { manifest: null, integrity: 'invalid' };
}

export function assertWritableManifest(read: ManifestRead): void {
  if (read.integrity === 'newer_schema') {
    throw new VaultSchemaError('The vault manifest was written by a newer engine; refusing to overwrite it.');
  }
  if (read.integrity === 'invalid') {
    throw new VaultIntegrityError('The vault manifest is unreadable; refusing to write over it. Repair .meta/manifest.json first.');
  }
}
