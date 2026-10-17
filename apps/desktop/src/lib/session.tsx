import { useQueryClient } from '@tanstack/react-query';
import { type DevicePollResult, type DeviceProfile, type DeviceSignInStart, type EngineLoginResponse, type SessionAccess, type SessionMode } from '@sef/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, EngineError, setEngineSession } from './api';
import { currentEngineTarget } from './seat';
import { log } from './log';
import { setActiveProfile } from './queries';

export interface Session {
  kind: 'student';
  token: string;
  profile: DeviceProfile;
  mode: SessionMode;
  access?: SessionAccess;
}

type SessionState = { status: 'checking' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };

interface SessionContextValue {
  state: SessionState;
  signIn: (email: string, password: string) => Promise<Session>;
  signOut: () => Promise<void>;
  /** First-time university sign-in: the engine opens a device grant and returns the code to show. */
  startDeviceSignIn: () => Promise<DeviceSignInStart>;
  /** One poll of the in-flight grant. Activates the session itself when it comes back approved. */
  pollDeviceSignIn: () => Promise<DevicePollResult>;
  /** Offline entry for a profile that has already signed in online on this device. */
  unlockOffline: (profileId: string) => Promise<Session>;
  /** Re-read the engine's view of this session, so a pending approval can turn into access. */
  refresh: () => Promise<Session | null>;
}

const STORAGE_KEY = 'sef.session';
const SessionContext = createContext<SessionContextValue | null>(null);

// Tokens live in sessionStorage, never localStorage: the engine session dies with the
// window, which is the intended lifetime — relaunching the app means signing in again.
const readStored = (): Session | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    // Builds before the registrar portal could persist a staff session here; those are
    // not student sessions, so they are dropped rather than restored.
    return parsed.kind === 'student' ? parsed : null;
  } catch {
    return null;
  }
};

const store = (session: Session | null) => {
  if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(STORAGE_KEY);
};

async function endWorkspaceOnSignOut(): Promise<void> {
  try {
    await api.endWorkspace();
    log.info('workspace_ended_on_sign_out', {});
  } catch (error) {
    if (error instanceof EngineError && (error.code === 'not_hosted' || error.code === 'workspace_ended')) return;
    log.warn('workspace_end_failed', { code: error instanceof EngineError ? error.code : undefined });
    toast.warning('Signed out, but the university could not be told to close your workspace. It closes itself after a period without use; your notes are saved to your university storage either way.');
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: 'checking' });
  /** Binds polls to the grant this client started; a hosted engine refuses polls without it. */
  const flowKey = useRef<string | undefined>(undefined);

  const clear = useCallback(
    (reason: string) => {
      log.info('session_cleared', { reason });
      setEngineSession(null);
      setActiveProfile(null);
      store(null);
      // Cancel first: a response already in flight would otherwise repopulate the cache
      // after the clear and leak the previous student's data into the next session.
      void queryClient.cancelQueries();
      queryClient.clear();
      setState({ status: 'signed-out' });
    },
    [queryClient],
  );

  const activate = useCallback(
    (session: Session) => {
      setEngineSession(session.token, () => {
        toast.info('Your session ended. Please sign in again.');
        clear('engine_rejected_token');
      });
      setActiveProfile(session.profile.id);
      store(session);
      void queryClient.cancelQueries();
      queryClient.clear();
      setState({ status: 'signed-in', session });
    },
    [clear, queryClient],
  );

  // Restore on launch: the stored session is re-validated with the engine (works offline too).
  useEffect(() => {
    const stored = readStored();
    if (!stored) return setState({ status: 'signed-out' });
    setEngineSession(stored.token);
    api
      .me()
      .then((me) => activate({ ...stored, profile: me.profile, mode: me.mode, access: me.access }))
      .catch((error) => {
        log.warn('session_restore_failed', { error: String(error) });
        clear('restore_failed');
      });
  }, [activate, clear]);

  const studentSession = useCallback(
    (res: EngineLoginResponse): Session => {
      const session: Session = { kind: 'student', token: res.token, profile: res.profile, mode: res.mode, access: res.access };
      log.info('signed_in', { kind: 'student', mode: res.mode, admission: res.profile.admission ?? 'legacy' });
      return session;
    },
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const session = studentSession(await api.login(email, password));
      activate(session);
      return session;
    },
    [activate, studentSession],
  );

  const signOut = useCallback(async () => {
    if (state.status === 'signed-in') {
      // A hosted workspace ends with the sign-out: the university saves the notes and deletes the VM.
      // It must go first, while the engine still holds the university credential it relays with.
      if (currentEngineTarget().kind === 'served') await endWorkspaceOnSignOut();
      await api.logout().catch((error) => log.warn('logout_failed', { error: String(error) }));
    }
    clear('user_signed_out');
  }, [clear, state]);

  const startDeviceSignIn = useCallback(async () => {
    const grant = await api.startDeviceSignIn();
    flowKey.current = grant.flowKey;
    log.info('device_signin_started', { expiresInSeconds: grant.expiresInSeconds });
    return grant;
  }, []);

  const pollDeviceSignIn = useCallback(async () => {
    const result = await api.pollDeviceSignIn(flowKey.current);
    if (result.status === 'approved') activate(studentSession(result));
    return result;
  }, [activate, studentSession]);

  const unlockOffline = useCallback(
    async (profileId: string) => {
      const res = await api.offlineLogin(profileId);
      log.info('offline_unlocked', { profileId, admission: res.profile.admission ?? 'legacy' });
      const session = studentSession(res);
      activate(session);
      return session;
    },
    [activate, studentSession],
  );

  const refresh = useCallback(async () => {
    if (state.status !== 'signed-in') return null;
    try {
      const me = await api.me();
      const next = { ...state.session, profile: me.profile, mode: me.mode, access: me.access };
      activate(next);
      return next;
    } catch (error) {
      // A rejected/expired engine session clears itself via the 401 handler; a transient
      // failure should not sign the student out, so leave the session in place.
      log.warn('session_refresh_failed', { error: String(error) });
      return null;
    }
  }, [activate, state]);

  const value = useMemo(
    () => ({ state, signIn, signOut, startDeviceSignIn, pollDeviceSignIn, unlockOffline, refresh }),
    [state, signIn, signOut, startDeviceSignIn, pollDeviceSignIn, unlockOffline, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** The signed-in student. Only call inside the student shell. */
export function useStudent() {
  const { state } = useSession();
  if (state.status !== 'signed-in') throw new Error('useStudent outside student shell');
  return state.session;
}
