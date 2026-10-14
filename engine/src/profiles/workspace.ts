import { mkdir } from 'node:fs/promises';
import type { DeviceProfile } from '@sef/shared';
import { BrainService } from '../brain/service';
import { BrainVault } from '../brain/vault';
import { log, profilePaths, type ProfilePaths } from '../config';
import { ContentStore } from '../content/store';
import { ContentSync } from '../content/sync';
import { SessionStore } from '../sessions/store';
import type { SettingsStore } from '../settings/store';
import type { ProfileRegistry } from './registry';

/** Everything the engine needs to serve one student. One per profile, created lazily and cached. */
export interface Workspace {
  profile: DeviceProfile;
  paths: ProfilePaths;
  content: ContentStore;
  vault: BrainVault;
  brain: BrainService;
  sessions: SessionStore;
  sync: ContentSync;
}

export class WorkspaceManager {
  private readonly cache = new Map<string, Promise<Workspace>>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly registry: ProfileRegistry,
  ) {}

  get(profile: DeviceProfile): Promise<Workspace> {
    let ws = this.cache.get(profile.id);
    if (!ws) {
      ws = this.open(profile).catch((error) => {
        this.cache.delete(profile.id);
        throw error;
      });
      this.cache.set(profile.id, ws);
    }
    return ws.then((w) => Object.assign(w, { profile }));
  }

  private async open(profile: DeviceProfile): Promise<Workspace> {
    const paths = profilePaths(profile.id);
    await Promise.all([paths.content, paths.sessions, paths.quizzes].map((dir) => mkdir(dir, { recursive: true })));
    const content = new ContentStore(paths.content);
    const vault = new BrainVault(paths.brain);
    await vault.init();
    const workspace: Workspace = {
      profile,
      paths,
      content,
      vault,
      brain: new BrainService(content, vault, this.settings, paths.quizzes),
      sessions: new SessionStore(paths.sessions),
      sync: new ContentSync(this.settings, content, async () => ({
        cohortId: workspace.profile.cohortId,
        uniToken: await this.registry.uniToken(profile.id),
      })),
    };
    log.info('workspace_opened', { profileId: profile.id, root: paths.root });
    return workspace;
  }
}
