import { mkdir } from 'node:fs/promises';
import type { DeviceProfile } from '@sef/shared';
import { BrainService } from '../brain/service';
import { BrainVault } from '../brain/vault';
import { WikiStore } from '../brain/wiki-store';
import { log, profilePaths, type ProfilePaths } from '../config';
import { ProfileSettingsStore } from '../settings/store';
import { ContentStore } from '../content/store';
import { ContentSync } from '../content/sync';
import { SessionStore } from '../sessions/store';
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
  brain: BrainService;
  sessions: SessionStore;
  sync: ContentSync;
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
    const vault = new BrainVault(paths.brain);
    await vault.init();
    const workspace: Workspace = {
      profile: { ...profile },
      paths,
      settings,
      content,
      vault,
      wiki,
      brain: new BrainService(content, vault, settings, paths.quizzes),
      sessions: new SessionStore(paths.sessions),
      sync: new ContentSync(settings, content, async () => {
        const currentProfile = await this.registry.get(profileId);
        return {
          cohortId: currentProfile?.cohortId ?? profile.cohortId,
          uniToken: await this.registry.uniToken(profileId),
        };
      }),
    };
    log.info('workspace_opened', { profileId, root: paths.root });
    return workspace;
  }
}
