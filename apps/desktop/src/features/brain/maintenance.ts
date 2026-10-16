import type { FindingKind, MaintenanceFinding } from '@sef/shared';
import type { BadgeTone } from '../contribute/review';

/**
 * Presentation helpers for the maintenance list — kept pure so the wording and the
 * actionable/reviewable split are tested without a DOM.
 */

export const FINDING_LABEL: Record<FindingKind, string> = {
  orphan: 'Orphan page',
  missing_source: 'Missing source',
  missing_citation: 'Missing citation',
  dead_link: 'Dead link',
  unrecorded_link: 'Unrecorded link',
  unindexed: 'Not in the index',
  bad_mapping: 'Course mapping',
  oversized: 'Oversized page',
  schema_issue: 'Schema issue',
  revision_drift: 'Changed outside the keeper',
  contradiction: 'Possible contradiction',
  stale_claim: 'Possibly out of date',
  missing_connection: 'Missing connection',
  open_question: 'A question worth asking',
};

/** ember for things structurally wrong, gold for model guesses, beacon for prompts to think. */
export function findingTone(finding: MaintenanceFinding): BadgeTone {
  if (finding.origin === 'semantic') return 'gold';
  switch (finding.kind) {
    case 'schema_issue':
    case 'revision_drift':
    case 'missing_source':
    case 'missing_citation':
    case 'dead_link':
      return 'ember';
    case 'unindexed':
    case 'bad_mapping':
      return 'rose';
    default:
      return 'beacon';
  }
}

/** Only these findings carry a mechanical repair a proposal can express. */
export function isActionable(finding: MaintenanceFinding): boolean {
  return finding.action.kind === 'add_link' || finding.action.kind === 'repair_page';
}

/** Catalogue findings repair index.md directly — they never become page proposals. */
export function needsCatalogueRepair(finding: MaintenanceFinding): boolean {
  return finding.action.kind === 'rebuild_catalogue';
}

/** One phrase for what accepting the repair would do — shown beside the checkbox. */
export function actionLabel(finding: MaintenanceFinding): string | null {
  const action = finding.action;
  if (action.kind === 'add_link') return `link to ${action.toPageId}`;
  if (action.kind === 'rebuild_catalogue') return 'rebuild the index';
  if (action.kind === 'suggestion') return null;
  switch (action.repair) {
    case 'course_mapping':
      return 'fix the course mapping';
    case 'dead_source_refs':
      return 'drop dead references';
    case 'dead_links':
      return 'remove dead links';
    case 'adopt_schema':
      return 'adopt into the typed format';
    case 'adopt_drift':
      return 'keep the on-disk words';
    case 'supersede_claim':
      return 'mark the claim superseded';
    case 'dispute_claim':
      return 'mark both claims disputed';
    case 'append_question':
      return 'record the question';
  }
}

/** Structural findings first (the vault's own rules), semantic suggestions after them. */
export function sortFindings(findings: MaintenanceFinding[]): MaintenanceFinding[] {
  return [...findings].sort((a, b) => Number(a.origin === 'semantic') - Number(b.origin === 'semantic'));
}

/** The review's own status line — honest about never having run, and about failing. */
export function semanticStatusLine(semantic: { state: 'never_run' | 'ran' | 'failed'; lastRunAt: string | null; model: string | null; note?: string }): string {
  if (semantic.state === 'never_run') return 'The deeper review has not run yet — it reads your pages with the brain model and only ever suggests.';
  if (semantic.state === 'failed') return 'The last semantic review failed — the model may be unavailable. The deterministic findings above still stand.';
  return `Last semantic review ${semantic.lastRunAt ?? ''}${semantic.model ? ` by ${semantic.model}` : ''} — its suggestions cite their evidence and wait for you.`;
}
