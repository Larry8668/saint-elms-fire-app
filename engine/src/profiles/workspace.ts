import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceProfile, ProfileIdentity } from '@sef/shared';
import { WikiCompiler } from '../brain/compiler/compile';
import { evidenceResolver } from '../brain/evidence';
import { MaintenanceService } from '../brain/maintenance/service';
import { VaultPortabilityService } from '../brain/portable/service';
import { BrainService } from '../brain/service';
import { SourceIngestor, SourceRejection } from '../brain/sources/ingest';
import { BrainVault } from '../brain/vault';
import { META_DIRECTORY, META_EMBEDDINGS_DIRECTORY, vaultPath } from '../brain/vault-layout';
import { WikiStore } from '../brain/wiki-store';
import { log, profilePaths, type ProfilePaths } from '../config';
import { EmbeddingIndex } from '../embed/index';
import { EmbeddingService } from '../embed/service';
import { LogisticsStore } from '../logistics/store';
import { AudioTranscriber } from '../media/audio';
import { VisionImageReader } from '../media/vision';
import { YouTube } from '../media/youtube';
import { ProfileSettingsStore } from '../settings/store';
import { ContentStore } from '../content/store';
import { ContentSync } from '../content/sync';
import { SessionStore } from '../sessions/store';
import { PeerShareService } from '../shares/service';
import { ShareScreener } from '../shares/screen';
import { PeerShareStore } from '../shares/store';
import { gatherSignalInputs } from '../signals/inputs';
import { SignalService } from '../signals/service';
import { SignalStore } from '../signals/store';
import { FeedService } from '../feeds/service';
import { FeedStore } from '../feeds/store';
import { listProposalRecords } from '../brain/proposals';
import { MetricsLog } from '../eval/log';
import { MetricsService } from '../eval/service';
import { modelPlanner } from '../plans/planner';
import { PlanService } from '../plans/service';
import { PlanStore } from '../plans/store';
import { gatherPlanWorld } from '../plans/world';
import { modelRephrase } from '../suggest/draft';
import { gatherSeedInputs } from '../suggest/inputs';
import { SuggestionService } from '../suggest/service';
import { SuggestionStore } from '../suggest/store';
import { probeHealth } from '../system/health';
import type { SettingsStore } from '../settings/store';
import type { ProfileRegistry } from './registry';

/** Everything the engine needs to serve one student. One per profile, created lazily and cached. */
export interface Workspace {
  profile: DeviceProfile;
  paths: ProfilePaths;
  settings: ProfileSettingsStore;
  content: ContentStore;
  vault: BrainVault;
  wiki: WikiStore;
  sources: SourceIngestor;
  compiler: WikiCompiler;
  maintenance: MaintenanceService;
  /** Export and restore of the student's own vault — independent of enrolment or network. */
  portable: VaultPortabilityService;
  brain: BrainService;
  /** The semantic lane: a derived, vault-scoped vector index over the student's own pages and lessons. */
  embeddings: EmbeddingService;
  sessions: SessionStore;
  sync: ContentSync;
  peerShares: PeerShareService;
  /** Private campus logistics — the student's own deadlines, never shared or taught. */
  logistics: LogisticsStore;
  /** Consent-gated YouTube preview/fetch — the only egress beside SearXNG. */
  youtube: YouTube;
  /** Derived attention signals over the stores above — no model calls, no new egress. */
  signals: SignalService;
  /** Per-teacher suggested questions; code picks them, a model may only rephrase (opt-in). */
  suggestions: SuggestionService;
  /** Consented subject feeds — the only egress the agentic series adds. */
  feeds: FeedService;
  /** Student-approved study plans; a model proposes, code validates, evidence moves steps. */
  plans: PlanService;
  /** Local-only evaluation counters; never exported, never sent. */
  metrics: MetricsService;
}

export class WorkspaceManager {
  private readonly cache = new Map<string, Promise<Workspace>>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly registry: ProfileRegistry,
    private readonly pathsForProfile: (profileId: string) => ProfilePaths = profilePaths,
  ) {}

  get(profile: DeviceProfile): Promise<Workspace> {
    const context = { ...profile };
    let cached = this.cache.get(context.id);
    if (!cached) {
      cached = this.open(context).catch((error) => {
        this.cache.delete(context.id);
        throw error;
      });
      this.cache.set(context.id, cached);
    }
    return cached.then((workspace) => ({ ...workspace, profile: { ...context } }));
  }

  /** Workspaces a signed-in session currently holds open; a dropped (logged-out) profile is never listed. */
  async opened(): Promise<Workspace[]> {
    const settled = await Promise.allSettled(this.cache.values());
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  /** Drops the cached workspace so logout leaves no profile state held in memory. */
  drop(profileId: string): void {
    this.cache.delete(profileId);
  }

  private async open(profile: DeviceProfile): Promise<Workspace> {
    const profileId = profile.id;
    const paths = this.pathsForProfile(profileId);
    await Promise.all([paths.content, paths.sessions, paths.quizzes].map((dir) => mkdir(dir, { recursive: true })));
    const settings = new ProfileSettingsStore(this.settings, paths.privateSettings);
    const content = new ContentStore(paths.content);
    // The wiki store owns the vault layout, SCHEMA.md and recovery; the concept vault reads what it writes.
    const wiki = new WikiStore(paths.brain);
    await wiki.init();
    await wiki.recover();
    const vault = new BrainVault(paths.brain, evidenceResolver(paths.quizzes, wiki));
    await vault.init();

    /**
     * The identity a source or proposal is filed under. `programmeId` is learned at device
     * sign-in; profiles from before that field existed fall back to the cohort — the honest
     * scope the engine can assert — and a profile with neither is refused outright.
     */
    const identity = async (): Promise<ProfileIdentity> => {
      const [{ uniServerUrl }, current] = await Promise.all([settings.get(), this.registry.get(profileId)]);
      const live = current ?? profile;
      const programmeId = live.programmeId ?? (live.cohortId || undefined);
      if (!programmeId) {
        throw new SourceRejection('This profile is not linked to a programme yet. Sign in online once more first.', 'no_programme', 409);
      }
      return { issuer: uniServerUrl, studentId: profileId, programmeId };
    };

    const sources = new SourceIngestor(wiki, identity, new AudioTranscriber(settings), new VisionImageReader(settings));
    const compiler = new WikiCompiler(wiki, { settings, content, profile: identity });
    // The index lives inside the vault's .meta — profile-scoped, atomic, rebuildable.
    const embeddings = new EmbeddingService({
      index: new EmbeddingIndex(vaultPath(paths.brain, META_DIRECTORY, META_EMBEDDINGS_DIRECTORY)),
      settings,
    });
    const maintenance = new MaintenanceService({ wiki, content, settings, identity, similarPages: embeddings.pairsFor('pages') });
    const logistics = new LogisticsStore(path.join(paths.root, 'logistics.json'));
    const sessions = new SessionStore(paths.sessions);
    // Counters sit beside the other operational stores, outside the vault and its exports.
    const metrics = new MetricsService({
      log: new MetricsLog(path.join(paths.root, 'eval-events.jsonl')),
      turns: () => sessions.turnOutcomes(),
      proposals: async () => {
        const decided = (await listProposalRecords(wiki.root)).filter((r) => r.decidedBy === 'student');
        return { accepted: decided.filter((r) => r.state === 'accepted').length, rejected: decided.filter((r) => r.state === 'rejected').length };
      },
    });
    const feeds = new FeedService({
      store: new FeedStore(path.join(paths.root, 'feeds.json')),
      courses: async () =>
        Object.values(await content.installed()).map((c) => ({ courseId: c.id, signedMetadata: c.signedMetadata === true, subjectFeeds: c.subjectFeeds })),
    });
    const signals = new SignalService({
      store: new SignalStore(path.join(paths.root, 'signals.json')),
      record: metrics.record,
      proactivity: async () => (await settings.get()).proactivity,
      inputs: () =>
        gatherSignalInputs({
          logistics: () => logistics.list(),
          jobs: async () => (await sources.list()).jobs,
          pages: () => wiki.listPages(),
          events: () => wiki.listEvents(),
          maintenance: () => maintenance.report(),
          health: async () => probeHealth(await settings.get()),
          feeds: () => feeds.snapshot(),
        }),
    });
    const brain = new BrainService(content, vault, settings, paths.quizzes, { wiki, sources, identity });
    // Plans are operational state: kept under the profile root, outside the vault and its exports.
    const plans = new PlanService({
      store: new PlanStore(path.join(paths.root, 'plans')),
      draft: modelPlanner(() => settings.get()),
      record: metrics.record,
      world: () =>
        gatherPlanWorld({
          pages: () => wiki.listPages(),
          events: () => wiki.listEvents(),
          lessons: () => content.academicLessons(),
          installed: () => content.installed(),
          signals: () => signals.entries(),
          quizzes: () => brain.quizResults(),
          lessonActivity: () => sessions.lessonActivity(),
        }),
    });
    const suggestions = new SuggestionService({
      store: new SuggestionStore(paths.root),
      proactivity: async () => (await settings.get()).proactivity,
      recentTurns: (teacher) => sessions.recentUserTurns(teacher),
      rephrase: modelRephrase(() => settings.get()),
      inputs: () =>
        gatherSeedInputs({
          logistics: () => logistics.list(),
          pages: () => wiki.listPages(),
          events: () => wiki.listEvents(),
          maintenance: () => maintenance.report(),
          concepts: async () => [...(await vault.all()).values()],
          lessons: () => content.academicLessons(),
          studiedLessonIds: () => sessions.studiedLessonIds(),
          feedItems: async () => (await feeds.snapshot()).items,
          planSteps: () => plans.pendingSteps(),
        }),
    });
    const workspace: Workspace = {
      profile: { ...profile },
      paths,
      settings,
      content,
      vault,
      wiki,
      sources,
      compiler,
      maintenance,
      // Identity for export provenance tolerates an unlinked profile: portability cannot wait
      // on enrolment state, so the fallback only names who held the vault.
      portable: new VaultPortabilityService(wiki, {
        identity: async () => {
          try {
            return await identity();
          } catch {
            return { issuer: 'local', studentId: profileId, programmeId: profile.programmeId ?? profile.cohortId ?? 'local' };
          }
        },
      }),
      brain,
      embeddings,
      sessions,
      sync: new ContentSync(settings, content, async () => {
        const currentProfile = await this.registry.get(profileId);
        return {
          cohortId: currentProfile?.cohortId ?? profile.cohortId,
          uniToken: await this.registry.uniToken(profileId),
        };
      }),
      logistics,
      signals,
      suggestions,
      feeds,
      plans,
      metrics,
      youtube: new YouTube(),
      peerShares: new PeerShareService({
        wiki,
        sources,
        compiler,
        store: new PeerShareStore(path.join(paths.root, 'shares.json')),
        uniUrl: async () => (await settings.get()).uniServerUrl,
        uniToken: () => this.registry.uniToken(profileId),
        enrolment: async () => {
          const currentProfile = await this.registry.get(profileId);
          return {
            programmeId: (await identity()).programmeId,
            cohortId: currentProfile?.cohortId ?? profile.cohortId ?? null,
          };
        },
        screen: new ShareScreener(settings),
      }),
    };
    log.info('workspace_opened', { profileId, root: paths.root });
    return workspace;
  }
}
