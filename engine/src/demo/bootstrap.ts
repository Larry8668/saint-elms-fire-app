import { access } from 'node:fs/promises';
import { DEMO_PERSONAS } from '@sef/shared';
import { loadCourseware, type CoursewareIndex } from '@sef/shared/node';
import { config, errorFields, log } from '../config';
import type { ProfileRegistry } from '../profiles/registry';
import type { WorkspaceManager } from '../profiles/workspace';
import { seedPersona } from './seed';

async function localCourseware(): Promise<CoursewareIndex | null> {
  try {
    await access(config.demoCoursewareDir);
    return await loadCourseware(config.demoCoursewareDir);
  } catch (error) {
    log.warn('demo_courseware_unavailable', { dir: config.demoCoursewareDir, ...errorFields(error) });
    return null;
  }
}

/**
 * Makes the three demo students exist on this device, offline-ready, with populated brains.
 * Idempotent: profiles and vaults that already exist are left alone.
 */
export async function bootstrapDemo(registry: ProfileRegistry, workspaces: WorkspaceManager): Promise<void> {
  let courseware: CoursewareIndex | null | undefined;
  for (const persona of DEMO_PERSONAS) {
    await registry.ensure(
      { id: persona.id, name: persona.name, email: persona.email, cohortId: persona.cohortId, stage: persona.stage, persona: persona.persona },
      config.demoPassword,
    );
    const profile = await registry.get(persona.id);
    if (!profile) continue;
    const ws = await workspaces.get(profile);
    if (!(await ws.vault.isEmpty())) continue;
    courseware ??= await localCourseware();
    try {
      await seedPersona(ws, persona, courseware);
    } catch (error) {
      log.error('demo_seed_failed', { profileId: persona.id, ...errorFields(error) });
    }
  }
}
