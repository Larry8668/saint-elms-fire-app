import type { MiddlewareHandler } from 'hono';
import type { EngineMe } from '@sef/shared';
import type { AuthService } from '../profiles/auth';
import type { AnonymousDataManager } from '../profiles/anonymous';
import type { Workspace, WorkspaceManager } from '../profiles/workspace';
import type { SettingsStore } from '../settings/store';

export interface EngineDeps {
  settings: SettingsStore;
  auth: AuthService;
  workspaces: WorkspaceManager;
  anonymousData: AnonymousDataManager;
}

export type EngineEnv = { Variables: { me: EngineMe; ws: Workspace; token: string } };

export const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

/**
 * Resolves the engine session to a profile workspace. Every student route sits behind
 * this. `approved: true` additionally rejects profiles whose uni admission is not
 * approved — pending students see onboarding only, not their workspace. Profiles
 * without an admission field (password/demo profiles) predate the gate and pass.
 */
export function requireProfile(deps: EngineDeps, options: { approved?: boolean } = {}): MiddlewareHandler<EngineEnv> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    const me = token ? await deps.auth.resolve(token) : null;
    if (!token || !me) return c.json({ error: 'Sign in to continue', code: 'unauthenticated' }, 401);
    if (options.approved && me.profile.admission !== undefined && me.profile.admission !== 'approved') {
      return c.json({ error: 'Enrolment is not approved', code: 'unapproved' }, 403);
    }
    c.set('me', me);
    c.set('token', token);
    c.set('ws', await deps.workspaces.get(me.profile));
    await next();
  };
}
