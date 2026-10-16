import { MaintenanceFindingSchema, type FindingKind, type MaintenanceAction, type MaintenanceFinding } from '@sef/shared';
import { sha256Hex } from '../../lib/hash';
import type { PageSnapshot } from '../wiki-store';

/**
 * Finding ids derive from what the finding is about, not from a run — the same issue found
 * twice keeps one id, so a dismissal survives the next pass and a re-run does not flood the
 * list. `key` is the stable subject material (page ids, target ids), never volatile prose.
 */
export function findingId(kind: FindingKind, ...key: string[]): string {
  return `f_${sha256Hex(`${kind}|${key.join('|')}`).slice(0, 20)}`;
}

/** The revision each page sat at — a later edit makes a finding (and its repair) stale. */
export function pageRevisions(pages: Map<string, PageSnapshot>, ids: string[]): Record<string, string> {
  const revisions: Record<string, string> = {};
  for (const id of ids) {
    const snapshot = pages.get(id);
    if (snapshot) revisions[id] = snapshot.revision;
  }
  return revisions;
}

export function makeFinding(
  input: Omit<MaintenanceFinding, 'id' | 'evidence' | 'action'> &
    Partial<Pick<MaintenanceFinding, 'evidence' | 'action'>> & { key: string[] },
): MaintenanceFinding {
  const { key, ...rest } = input;
  return MaintenanceFindingSchema.parse({
    evidence: [],
    action: { kind: 'suggestion' } satisfies MaintenanceAction,
    ...rest,
    id: findingId(input.kind, ...key),
  });
}
