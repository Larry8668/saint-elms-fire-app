import { Hono, type Context } from 'hono';
import type { WorkspaceEndResult, WorkspaceInfo } from '@sef/shared';
import { log } from '../../config';
import { UniHttpError, uniRequest, UniUnreachableError } from '../../uni/client';
import { requireProfile, type EngineDeps, type EngineEnv } from '../context';
import { parsePublicHost } from '../edge';

/**
 * The student's ephemeral workspace lease (PR-42), from the VM's side. The browser on the VM
 * cannot call the university itself (the served UI's CSP is same-origin, and the uni session
 * cookie lives on the uni's origin), so the engine relays the two calls the lease needs with
 * the credential it already holds for this profile. Nothing here takes a session id: the uni
 * picks the caller's own session from that credential.
 */
export const isHostedWorkspace = (env: NodeJS.ProcessEnv = process.env) =>
  parsePublicHost(env.ENGINE_PUBLIC_HOST) !== null && Boolean(env.ENGINE_SEAT_OWNER?.trim());

export function workspaceRoutes(deps: EngineDeps, env: NodeJS.ProcessEnv = process.env) {
  const app = new Hono<EngineEnv>();
  const hosted = isHostedWorkspace(env);
  // A limited (read/export-only) session still keeps its lease alive and may end it.
  const student = requireProfile(deps, { limitedWrites: true });

  const relay = async (profileId: string, method: 'POST' | 'DELETE', path: string) => {
    const token = await deps.auth.uniToken(profileId);
    if (!token) return { kind: 'no_credential' as const };
    const { uniServerUrl } = await deps.settings.get();
    try {
      const { data } = await uniRequest<{ state?: string }>(uniServerUrl, path, { method, token, timeoutMs: 8_000 });
      return { kind: 'ok' as const, state: typeof data?.state === 'string' ? data.state : 'unknown' };
    } catch (error) {
      if (error instanceof UniUnreachableError) return { kind: 'unreachable' as const };
      if (error instanceof UniHttpError && error.status === 404) return { kind: 'ended' as const };
      if (error instanceof UniHttpError && (error.status === 401 || error.status === 403)) return { kind: 'refused' as const };
      log.warn('workspace_relay_failed', { path, status: error instanceof UniHttpError ? error.status : 0 });
      return { kind: 'unreachable' as const };
    }
  };

  app.get('/workspace', student, async (c) => {
    const { uniServerUrl } = await deps.settings.get();
    const body: WorkspaceInfo = { hosted, portalUrl: hosted ? `${uniServerUrl.replace(/\/+$/, '')}/app/` : null };
    return c.json(body);
  });

  const answer = (c: Context<EngineEnv>, result: Awaited<ReturnType<typeof relay>>) => {
    switch (result.kind) {
      case 'ok':
        return c.json({ ok: true, state: result.state } satisfies WorkspaceEndResult);
      case 'ended':
        return c.json({ error: 'This workspace session has ended.', code: 'workspace_ended' }, 410);
      case 'no_credential':
      case 'refused':
        return c.json({ error: 'The university no longer accepts this sign-in. Sign in again.', code: 'uni_session_expired' }, 403);
      default:
        return c.json({ error: 'The university server could not be reached.', code: 'uni_unreachable' }, 502);
    }
  };

  app.post('/workspace/heartbeat', student, async (c) => {
    if (!hosted) return c.json({ error: 'This engine is not a hosted workspace.', code: 'not_hosted' }, 404);
    return answer(c, await relay(c.get('me').profile.id, 'POST', '/v1/session/heartbeat'));
  });

  /** Ends the lease: the university flushes the vault one last time, then deletes this VM. */
  app.delete('/workspace', student, async (c) => {
    if (!hosted) return c.json({ error: 'This engine is not a hosted workspace.', code: 'not_hosted' }, 404);
    const result = await relay(c.get('me').profile.id, 'DELETE', '/v1/session');
    if (result.kind === 'ok') log.info('workspace_end_requested', { profileId: c.get('me').profile.id });
    return answer(c, result);
  });

  return app;
}
