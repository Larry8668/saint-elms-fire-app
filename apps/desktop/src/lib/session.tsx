import { useQueryClient } from '@tanstack/react-query';
import { peekTokenClaims, type Account, type DevicePollResult, type DeviceProfile, type DeviceSignInStart, type EngineLoginResponse, type SessionMode } from '@sef/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, setEngineSession } from './api';
import { log } from './log';
import { setActiveProfile } from './queries';

export type Session =
  | { kind: 'student'; token: string; profile: DeviceProfile; mode: SessionMode }
  /** Admins talk to the uni server directly with a uni-issued token. */
  | { kind: 'admin'; uniToken: string; uniUrl: string; account: Account };

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
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
};

const store = (session: Session | null) => {
  if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(STORAGE_KEY);
};

const adminTokenValid = (token: string) => {
  const claims = peekTokenClaims(token);
  return Boolean(claims && claims.role === 'admin' && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now());
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: 'checking' });

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
      if (session.kind === 'student') {
        setEngineSession(session.token, () => {
          toast.info('Your session ended. Please sign in again.');
          clear('engine_rejected_token');
        });
        setActiveProfile(session.profile.id);
      } else {
        setEngineSession(null);
        setActiveProfile(null);
      }
      store(session);
      void queryClient.cancelQueries();
      queryClient.clear();
      setState({ status: 'signed-in', session });
    },
    [clear, queryClient],
  );

  // Restore on launch: student sessions are re-validated with the engine (works offline too).
  useEffect(() => {
    const stored = readStored();
    if (!stored) return setState({ status: 'signed-out' });
    if (stored.kind === 'admin') {
      return adminTokenValid(stored.uniToken) ? activate(stored) : clear('admin_token_expired');
    }
    setEngineSession(stored.token);
    api
      .me()
      .then((me) => activate({ ...stored, profile: me.profile, mode: me.mode }))
      .catch((error) => {
        log.warn('session_restore_failed', { error: String(error) });
        clear('restore_failed');
      });
  }, [activate, clear]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api.login(email, password);
      const session: Session =
        res.role === 'admin'
          ? { kind: 'admin', uniToken: res.uniToken, uniUrl: res.uniUrl, account: res.account }
          : { kind: 'student', token: res.token, profile: res.profile, mode: res.mode };
      log.info('signed_in', { kind: session.kind, mode: session.kind === 'student' ? session.mode : 'online' });
      activate(session);
      return session;
    },
    [activate],
  );

  const signOut = useCallback(async () => {
    if (state.status === 'signed-in' && state.session.kind === 'student') {
      await api.logout().catch((error) => log.warn('logout_failed', { error: String(error) }));
    }
    clear('user_signed_out');
  }, [clear, state]);

  const studentSession = useCallback(
    (res: Extract<EngineLoginResponse, { role: 'student' }>): Session => {
      const session: Session = { kind: 'student', token: res.token, profile: res.profile, mode: res.mode };
      log.info('signed_in', { kind: 'student', mode: res.mode, admission: res.profile.admission ?? 'legacy' });
      return session;
    },
    [],
  );

  const startDeviceSignIn = useCallback(async () => {
    const grant = await api.startDeviceSignIn();
    log.info('device_signin_started', { expiresInSeconds: grant.expiresInSeconds });
    return grant;
  }, []);

  const pollDeviceSignIn = useCallback(async () => {
    const result = await api.pollDeviceSignIn();
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
    if (state.status !== 'signed-in' || state.session.kind !== 'student') return null;
    try {
      const me = await api.me();
      const next = { ...state.session, profile: me.profile, mode: me.mode };
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
  if (state.status !== 'signed-in' || state.session.kind !== 'student') throw new Error('useStudent outside student shell');
  return state.session;
}

/** The signed-in admin. Only call inside the admin shell. */
export function useAdminSession() {
  const { state } = useSession();
  if (state.status !== 'signed-in' || state.session.kind !== 'admin') throw new Error('useAdminSession outside admin shell');
  return state.session;
}
