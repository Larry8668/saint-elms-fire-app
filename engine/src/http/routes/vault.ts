import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CONTRACT_VERSION,
  IdentifierSchema,
  SourceDependentsSchema,
  SourceEraseRequestSchema,
  SourceEraseResultSchema,
  VaultExportRequestSchema,
  VaultImportPreviewSchema,
  VaultImportRequestSchema,
  VaultImportResultSchema,
  VaultRestoreRequestSchema,
} from '@sef/shared';
import { VaultImportError } from '../../brain/portable/archive';
import { VaultConflictError, VaultPathError, VaultSchemaError } from '../../brain/vault-errors';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { friendlyError } from '../errors';

/**
 * Vault portability over HTTP: carry the student's own knowledge away, or restore it here.
 * Export, preview and dependency listing sit behind the local sign-in alone — an expired
 * entitlement or an unapproved enrolment can never hold a student's own files hostage.
 * Restoring and erasing are writes, so they keep the approved-profile guard every other
 * vault writer uses; neither ever touches the profile registry or admission state.
 */
export function vaultRoutes(deps: EngineDeps) {
  const app = new Hono<EngineEnv>();
  const owner = requireProfile(deps);
  const writer = requireProfile(deps, { approved: true });

  const handled = (error: unknown, fallbackCode: string): { body: { error: string; code: string; details?: unknown }; status: ContentfulStatusCode } => {
    if (error instanceof VaultImportError) return { body: { error: error.message, code: error.code }, status: error.status };
    if (error instanceof VaultConflictError) return { body: { error: error.message, code: 'stale_vault', details: error.details }, status: 409 };
    if (error instanceof VaultSchemaError) return { body: { error: error.message, code: 'incompatible_schema' }, status: 409 };
    if (error instanceof VaultPathError) return { body: { error: error.message, code: 'unsafe_path' }, status: 400 };
    return { body: { error: friendlyError(error), code: fallbackCode }, status: 500 };
  };

  /** The student's whole vault as one checksummed export; sourceIds narrows the originals included. */
  app.post('/vault/export', owner, async (c) => {
    const parsed = VaultExportRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Send an optional sourceIds selection', code: 'invalid_request' }, 400);
    try {
      return c.json(await c.get('ws').portable.exportVault({ sourceIds: parsed.data.sourceIds }));
    } catch (error) {
      const { body, status } = handled(error, 'export_failed');
      return c.json(body, status);
    }
  });

  /** What a restore would do — destination, size and conflicts — before anything is written. */
  app.post('/vault/import/preview', owner, async (c) => {
    const parsed = VaultImportRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the export under `archive`', code: 'invalid_request' }, 400);
    try {
      return c.json(VaultImportPreviewSchema.parse(await c.get('ws').portable.previewImport(parsed.data.archive)));
    } catch (error) {
      const { body, status } = handled(error, 'preview_failed');
      return c.json(body, status);
    }
  });

  /**
   * The restore itself. Conflict decisions arrive as overwritePageIds; the archive is
   * re-validated and re-planned inside the writer lock's preconditions, so a vault that
   * moved since the preview is refused rather than overwritten.
   */
  app.post('/vault/import', writer, async (c) => {
    const parsed = VaultRestoreRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send the export under `archive` and any overwritePageIds', code: 'invalid_request' }, 400);
    try {
      const result = await c.get('ws').portable.restore(parsed.data.archive, { overwritePageIds: parsed.data.overwritePageIds });
      return c.json(VaultImportResultSchema.parse(result));
    } catch (error) {
      const { body, status } = handled(error, 'restore_failed');
      return c.json(body, status);
    }
  });

  /** What still cites a source — the list the student confirms against before erasing it. */
  app.get('/sources/:id/dependents', writer, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
    try {
      const pages = await c.get('ws').wiki.sourceDependents(id.data);
      return c.json(SourceDependentsSchema.parse({ schemaVersion: CONTRACT_VERSION, sourceId: id.data, pages }));
    } catch (error) {
      const { body, status } = handled(error, 'dependents_failed');
      return c.json(body, status);
    }
  });

  /**
   * Erasure is the student's own delete: the record, the derived extraction text and the
   * original bytes under raw/ all go — this is the one path allowed to touch raw/, and no
   * model or maintenance action reaches it. A tombstone records the delete for a future
   * sync, and the answer lists what was orphaned.
   */
  app.post('/sources/:id/erase', writer, async (c) => {
    const id = IdentifierSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
    const parsed = SourceEraseRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Send an optional expectedRevision', code: 'invalid_request' }, 400);
    try {
      const result = await c.get('ws').wiki.eraseSource(id.data, parsed.data.expectedRevision);
      if (!result.erased) return c.json({ error: 'Source not found', code: 'not_found' }, 404);
      return c.json(SourceEraseResultSchema.parse({ schemaVersion: CONTRACT_VERSION, erased: true, dependents: result.dependents }));
    } catch (error) {
      const { body, status } = handled(error, 'erase_failed');
      return c.json(body, status);
    }
  });

  return app;
}
