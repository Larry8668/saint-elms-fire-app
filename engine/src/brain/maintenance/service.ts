import {
  CONTRACT_VERSION,
  MaintenanceReportSchema,
  MaintenanceProposalResultSchema,
  CatalogueRepairResultSchema,
  SemanticReviewResultSchema,
  type CatalogueRepairResult,
  type Lesson,
  type MaintenanceFinding,
  type MaintenanceProposalResult,
  type MaintenanceReport,
  type ProfileIdentity,
  type SemanticReviewResult,
} from '@sef/shared';
import { generateStructured } from '../../agents/factory';
import { errorFields, log } from '../../config';
import type { ContentStore } from '../../content/store';
import type { EmbedPairsFn } from '../../embed/hybrid';
import { resolveModel } from '../../models/registry';
import type { SettingsReader } from '../../settings/store';
import { buildCourseGraph, type CourseGraph } from '../course-graph';
import { listProposalRecords, pendingProposalRecord, writeProposalRecord } from '../proposals';
import { pageEmbedKey, pageEmbedText } from '../query';
import type { WikiStore } from '../wiki-store';
import { structuralFindings, type StructuralInput } from './checks';
import { findingId } from './findings';
import { buildMaintenanceProposal } from './repair';
import { buildReviewPrompt, draftToFindings, selectReviewPages, semanticFindingValid, SEMANTIC_REVIEW_INSTRUCTIONS, SemanticReviewDraftSchema, type SemanticReviewDraft } from './semantic';
import { dismissFinding, readMaintenanceState, writeMaintenanceState, type MaintenanceState } from './state';

type ProposeFn = (prompt: string) => Promise<SemanticReviewDraft>;

/** The proposal id prefix marks a code-built maintenance proposal in the review queue. */
export const MAINTENANCE_PROPOSAL_PREFIX = 'prop_maint_';
export const isMaintenanceProposalId = (id: string): boolean => id.startsWith(MAINTENANCE_PROPOSAL_PREFIX);

/**
 * Wiki maintenance: the deterministic structural checks run on every call; the semantic
 * review is a bounded, student-invoked model pass whose validated suggestions persist until
 * the pages they cite change. Findings never write — actionable ones become a code-built
 * proposal the student reviews and accepts through the ordinary proposal machinery.
 */
export class MaintenanceService {
  private graphCache: { lessons: Lesson[]; graph: CourseGraph } | null = null;
  private readonly proposeFn: ProposeFn;

  constructor(
    private readonly deps: {
      wiki: WikiStore;
      content: ContentStore;
      settings: SettingsReader;
      identity: () => Promise<ProfileIdentity>;
      /** The similarity signal for review page selection; absent or unavailable → claims+recency only. */
      similarPages?: EmbedPairsFn;
      /** Test seam: produce the review draft without a model. */
      propose?: ProposeFn;
    },
  ) {
    this.proposeFn = deps.propose ?? ((prompt) => this.proposeWithModel(prompt));
  }

  private async courseGraph(): Promise<CourseGraph> {
    const lessons = await this.deps.content.academicLessons();
    if (this.graphCache?.lessons !== lessons) this.graphCache = { lessons, graph: buildCourseGraph(lessons) };
    return this.graphCache.graph;
  }

  private async proposeWithModel(prompt: string): Promise<SemanticReviewDraft> {
    const settings = await this.deps.settings.get();
    const resolved = resolveModel(settings, 'brain', { think: true });
    const { object } = await generateStructured({
      agentId: 'wiki-reviewer',
      instructions: SEMANTIC_REVIEW_INSTRUCTIONS,
      resolved,
      prompt,
      schema: SemanticReviewDraftSchema,
    });
    return object;
  }

  private async structuralInput(): Promise<StructuralInput> {
    const [pages, sources, indexText, course] = await Promise.all([
      this.deps.wiki.listPages(),
      this.deps.wiki.listSources(),
      this.deps.wiki.readIndex(),
      this.courseGraph(),
    ]);
    return { pages, sources, indexText, course };
  }

  /**
   * The live finding set: structural checks computed fresh, plus stored semantic findings
   * that still describe the vault (a manual edit or an accepted repair makes one vanish)
   * and were not dismissed.
   */
  private async currentFindings(input?: StructuralInput): Promise<{ findings: MaintenanceFinding[]; dismissed: number; state: MaintenanceState }> {
    const resolved = input ?? (await this.structuralInput());
    const state = await readMaintenanceState(this.deps.wiki.root);
    const byId = new Map(resolved.pages.map((page) => [page.id, page]));

    const findings = structuralFindings(resolved);
    const semantic = (state.semantic?.findings ?? []).filter((finding) => semanticFindingValid(finding, byId));
    // A deterministic unrecorded_link already covers the pair — the semantic guess adds nothing.
    const coveredPairs = new Set(findings.filter((f) => f.kind === 'unrecorded_link').map((f) => [...f.pageIds].sort().join('>')));
    const live = [...findings, ...semantic.filter((f) => f.kind !== 'missing_connection' || !coveredPairs.has([...f.pageIds].sort().join('>')))];

    const dismissedIds = new Set(state.dismissed.map((entry) => entry.id));
    const visible = live.filter((finding) => !dismissedIds.has(finding.id));
    return { findings: visible, dismissed: live.length - visible.length, state };
  }

  /** GET /api/brain/maintenance — every pass is logged; nothing is written by reading it. */
  async report(): Promise<MaintenanceReport> {
    const { findings, dismissed, state } = await this.currentFindings();
    log.info('wiki_lint_pass', { root: this.deps.wiki.root, findings: findings.length, dismissed });
    return MaintenanceReportSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      checkedAt: new Date().toISOString(),
      findings,
      dismissed,
      semantic: {
        state: state.semantic ? (state.semantic.note === 'failed' ? 'failed' : 'ran') : 'never_run',
        lastRunAt: state.semantic?.ranAt ?? null,
        model: state.semantic?.model ?? null,
        ...(state.semantic?.note ? { note: state.semantic.note } : {}),
      },
    });
  }

  /**
   * The bounded, student-invoked semantic pass. The model drafts candidate findings over a
   * capped page set; code validates every reference and drops what does not resolve. Results
   * are stored so the report endpoint can keep showing them until the pages move.
   */
  async review(): Promise<SemanticReviewResult> {
    const input = await this.structuralInput();
    const corpus = new Map(
      input.pages.filter((page) => page.format !== null && page.state === 'ok').map((page) => [pageEmbedKey(page), pageEmbedText(page)]),
    );
    const similarPairs = this.deps.similarPages ? await this.deps.similarPages(corpus) : null;
    const pages = selectReviewPages(input.pages, { similarPairs });
    const started = Date.now();
    let draft: SemanticReviewDraft;
    let model = 'reviewer';
    try {
      const settings = await this.deps.settings.get();
      model = resolveModel(settings, 'brain', { think: true }).label;
      draft = await this.proposeFn(buildReviewPrompt(pages));
    } catch (error) {
      const state = await readMaintenanceState(this.deps.wiki.root);
      await writeMaintenanceState(this.deps.wiki.root, {
        ...state,
        semantic: { ranAt: new Date().toISOString(), model, findings: state.semantic?.findings ?? [], note: 'failed' },
      });
      log.warn('wiki_semantic_review_failed', { root: this.deps.wiki.root, ...errorFields(error) });
      throw error;
    }

    const durationMs = Date.now() - started;
    const { findings, dropped } = draftToFindings(draft, pages);
    const at = new Date().toISOString();
    const state = await readMaintenanceState(this.deps.wiki.root);
    await writeMaintenanceState(this.deps.wiki.root, { ...state, semantic: { ranAt: at, model, findings } });
    await this.deps.wiki.appendLog({
      kind: 'maintenance',
      title: 'Semantic review finished',
      detail: `${findings.length} suggestion${findings.length === 1 ? '' : 's'} over ${pages.length} pages${dropped.length ? `, ${dropped.length} dropped by validation` : ''}.`,
    });
    log.info('wiki_semantic_review', { root: this.deps.wiki.root, findings: findings.length, dropped: dropped.length, pages: pages.length, ms: durationMs });
    return SemanticReviewResultSchema.parse({ schemaVersion: CONTRACT_VERSION, checkedAt: at, model, durationMs, pagesReviewed: pages.length, findings, dropped });
  }

  /**
   * Files one pending proposal covering the selected actionable findings. Findings that
   * cannot act (suggestions, catalogue repairs) or whose pages moved since the check are
   * skipped with reasons — the proposal record shows them in `dropped`.
   */
  async fileProposal(findingIds: string[]): Promise<MaintenanceProposalResult> {
    const input = await this.structuralInput();
    const { findings } = await this.currentFindings(input);
    const selected = findings.filter((finding) => findingIds.includes(finding.id));
    const missing = findingIds.filter((id) => !findings.some((finding) => finding.id === id));
    const skipped = missing.map((id) => ({ findingId: id, reason: 'Not a live finding — it may have been dismissed or already fixed.' }));

    // Findings already covered by a pending maintenance proposal are not filed twice.
    const pending = (await listProposalRecords(this.deps.wiki.root)).filter(
      (record) => record.state === 'pending' && isMaintenanceProposalId(record.proposal.id),
    );
    const claimed = new Set(pending.flatMap((record) => record.proposal.sourceIds));

    const conventions = await this.deps.wiki.readConventions();
    const built = buildMaintenanceProposal({
      findings: selected,
      pages: input.pages,
      liveSourceIds: new Set(Object.keys(input.sources)),
      course: input.course,
      profile: await this.deps.identity(),
      conventionRevision: conventions.conventions.revision,
      at: new Date().toISOString(),
      claimedFindings: claimed,
    });
    skipped.push(...built.skipped);

    let proposalId: string | null = null;
    if (built.proposal) {
      const dropped = built.skipped.map((skip) => ({ what: skip.findingId, reason: skip.reason }));
      await writeProposalRecord(this.deps.wiki.root, pendingProposalRecord(built.proposal, null, dropped));
      proposalId = built.proposal.id;
      await this.deps.wiki.appendLog({
        kind: 'maintenance',
        title: 'Maintenance repairs proposed',
        detail: `${built.filed.length} finding${built.filed.length === 1 ? '' : 's'} filed as proposal ${proposalId} — nothing lands until you accept.`,
      });
      log.info('wiki_maintenance_filed', { proposalId, findings: built.filed.length, skipped: built.skipped.length });
    }
    return MaintenanceProposalResultSchema.parse({ schemaVersion: CONTRACT_VERSION, proposalId, filed: built.filed, skipped });
  }

  /** A false or uncertain suggestion stays dismissed; the same finding cannot resurface. */
  async dismiss(findingIdValue: string, note?: string): Promise<MaintenanceReport> {
    await dismissFinding(this.deps.wiki.root, findingIdValue, new Date().toISOString(), note);
    log.info('wiki_finding_dismissed', { findingId: findingIdValue });
    return this.report();
  }

  /** The index/manifest repair — journaled, deterministic, no page content changes. */
  async repairCatalogue(): Promise<CatalogueRepairResult> {
    const result = await this.deps.wiki.repairCatalogue();
    log.info('wiki_catalogue_repair_run', { root: this.deps.wiki.root, ...result });
    return CatalogueRepairResultSchema.parse({ schemaVersion: CONTRACT_VERSION, ...result });
  }
}

export { findingId };
