import type { AdmissionMe } from '@sef/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSessionProbe } from '@/api/queries';
import { signInWithPassword, signOut, verifyTwoFactor, type SignInOutcome } from '@/api/session';

export type SessionStatus = 'checking' | 'signed-out' | 'staff' | 'not-staff';

interface SessionValue {
  status: SessionStatus;
  /** The probe's failure, so an unreachable server reads as unavailable and not as "signed out". */
  probeError: unknown;
  me: AdmissionMe | null;
  isOwner: boolean;
  /** Set when a mutation was refused for want of a session younger than 30 minutes. */
  reauthRequired: boolean;
  requireReauth(): void;
  clearReauth(): void;
  signIn(email: string, password: string): Promise<SignInOutcome>;
  submitTwoFactor(code: string): Promise<void>;
  signOutNow(): Promise<void>;
  /** Re-reads the session; also the fail-closed check that a sign-out really ended it. */
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const probe = useSessionProbe();
  const client = useQueryClient();
  const [reauthRequired, setReauthRequired] = useState(false);

  const refresh = useCallback(async () => {
    // Invalidate first so an errored probe refetches, then drop the cached record entirely.
    await client.invalidateQueries({ queryKey: ['auth-session'] });
    await client.removeQueries({ queryKey: ['auth-session'] });
  }, [client]);

  const value = useMemo<SessionValue>(() => {
    const data = probe.data;
    const status: SessionStatus = probe.isPending
      ? 'checking'
      : probe.isError || !data
        ? 'signed-out'
        : data.me.staffRoles.length > 0
          ? 'staff'
          : 'not-staff';

    return {
      status,
      probeError: probe.error,
      me: data?.me ?? null,
      isOwner: Boolean(data?.me.staffRoles.includes('owner')),
      reauthRequired,
      requireReauth: () => setReauthRequired(true),
      clearReauth: () => setReauthRequired(false),
      signIn: signInWithPassword,
      submitTwoFactor: verifyTwoFactor,
      signOutNow: async () => {
        await signOut();
        // Fail closed: if a session somehow survives the sign-out, drop every cached record
        // anyway and let the probe decide what the shell shows.
        client.clear();
        setReauthRequired(false);
        await refresh();
      },
      refresh,
    };
  }, [probe.data, probe.isPending, probe.isError, probe.error, reauthRequired, client, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}