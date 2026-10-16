import { CONTRACT_VERSION, MaintenanceFindingSchema, TimestampSchema, type MaintenanceFinding } from '@sef/shared';
import { z } from 'zod';
import { readJson, writeJson } from '../../lib/fs';
import { META_DIRECTORY, META_MAINTENANCE_FILE, vaultPath } from '../vault-layout';

/**
 * What maintenance remembers between passes: which findings the student dismissed (the same
 * finding keeps its id, so a dismissal survives re-runs) and the last semantic review's
 * validated findings. Everything else is recomputed fresh from the vault on each call.
 */
export const MaintenanceStateSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_VERSION),
  dismissed: z.array(
    z.strictObject({
      id: z.string().min(1).max(128),
      at: TimestampSchema,
      note: z.string().max(300).optional(),
    }),
  ),
  semantic: z
    .strictObject({
      ranAt: TimestampSchema,
      model: z.string(),
      findings: z.array(MaintenanceFindingSchema),
      note: z.string().max(400).optional(),
    })
    .nullable(),
});
export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>;

const EMPTY: MaintenanceState = { schemaVersion: CONTRACT_VERSION, dismissed: [], semantic: null };

export const maintenanceStatePath = (root: string): string => vaultPath(root, META_DIRECTORY, META_MAINTENANCE_FILE);

/** A missing or unreadable state file reads as empty — it is a cache of decisions, not truth. */
export async function readMaintenanceState(root: string): Promise<MaintenanceState> {
  const parsed = MaintenanceStateSchema.safeParse(await readJson<unknown>(maintenanceStatePath(root), null));
  return parsed.success ? parsed.data : EMPTY;
}

export async function writeMaintenanceState(root: string, state: MaintenanceState): Promise<void> {
  await writeJson(maintenanceStatePath(root), MaintenanceStateSchema.parse(state));
}

export async function dismissFinding(root: string, id: string, at: string, note?: string): Promise<MaintenanceState> {
  const state = await readMaintenanceState(root);
  if (state.dismissed.some((entry) => entry.id === id)) return state;
  const next: MaintenanceState = { ...state, dismissed: [...state.dismissed, { id, at, ...(note ? { note } : {}) }] };
  await writeMaintenanceState(root, next);
  return next;
}
