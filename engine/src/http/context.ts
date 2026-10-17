import type { MiddlewareHandler } from 'hono';
import type { EngineMe } from '@sef/shared';
import type { AuthService } from '../profiles/auth';
import type { AnonymousDataManager } from '../profiles/anonymous';
import type { Workspace, WorkspaceManager } from '../profiles/workspace';
import type { SettingsStore } from '../settings/store';
import type { VaultSyncHandle } from '../sync';

export interface EngineDeps {
  settings: SettingsStore;
  auth: AuthService;
  workspaces: WorkspaceManager;
  anonymousData: AnonymousDataManager;
  /** Present only on a session VM with vault sync on (OBJECT_STORE_* plus VAULT_SYNC_ACCOUNT). */
  vaultSync?: VaultSyncHandle;
}

export type EngineEnv = { Variables: { me: EngineMe; ws: Workspace; token: string } };

export const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

/**
 * Resolves the engine session to a profile workspace. Every student route sits behind
 * this. `approved: true` additionally rejects profiles whose uni admission is not
 * approved — pending students see onboarding only, not their workspace. Profiles
 * without an admission field (password/demo profiles) predate the gate and pass.
 *
 * A limited session (expired entitlement, suspended or withdrawn enrolment) is
 * read/export-only: GET and HEAD pass everywhere, including approved-gated routes —
 * the files are the student's own — while every other method answers 403 access_limited
 * unless the route opted in with `limitedWrites` (the vault export and sign-out do).
 * The default is deny, so a route added tomorrow cannot forget the check.
 */
export function requireProfile(deps: EngineDeps, options: { approved?: boolean; limitedWrites?: boolean } = {}): MiddlewareHandler<EngineEnv> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    const me = token ? await deps.auth.resolve(token) : null;
    if (!token || !me) return c.json({ error: 'Sign in to continue', code: 'unauthenticated' }, 401);
    const limited = me.access?.mode === 'limited';
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (limited && !safe && !options.limitedWrites) {
      return c.json({ error: 'This sign-in is read and export only. Sign in while online to restore full access.', code: 'access_limited' }, 403);
    }
    if (!limited && options.approved && me.profile.admission !== undefined && me.profile.admission !== 'approved') {
      return c.json({ error: 'Enrolment is not approved', code: 'unapproved' }, 403);
    }
    c.set('me', me);
    c.set('token', token);
    c.set('ws', await deps.workspaces.get(me.profile));
    await next();
  };
}
