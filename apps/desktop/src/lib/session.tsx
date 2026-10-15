import { useQueryClient } from '@tanstack/react-query';
import { peekTokenClaims, type Account, type DeviceProfile, type SessionMode } from '@sef/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, setEngineSession } from './api';
import { log } from './log';

export type Session =
  | { kind: 'student'; token: string; profile: DeviceProfile; mode: SessionMode }
  /** Admins talk to the uni server directly with a uni-issued token. */
  | { kind: 'admin'; uniToken: string; uniUrl: string; account: Account };

type SessionState = { status: 'checking' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };

interface SessionContextValue {
  state: SessionState;
  signIn: (email: string, password: string) => Promise<Session>;
  signOut: () => Promise<void>;
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
      store(null);
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
      } else {
        setEngineSession(null);
      }
      store(session);
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

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
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
