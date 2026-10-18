import { useCallback, useEffect, useState } from 'react';
import { AdmissionGate } from '@/features/auth/AdmissionGate';
import { admissionOf, mayEnterDashboard } from '@/features/auth/admission';
import { limitedReasonOf } from '@/features/auth/limited-access';
import { LimitedAccessView } from '@/features/auth/LimitedAccessView';
import { SignInView } from '@/features/auth/SignInView';
import { ChatProvider } from '@/features/teachers/chat-store';
import { NavProvider } from '@/lib/nav';
import { capture, identifyDemo } from '@/lib/analytics';
import { currentEngineTarget, workspaceDemoPersona } from '@/lib/seat';
import { useSession } from '@/lib/session';
import { App } from './App';
import { BootSplash } from './BootSplash';

/** Picks the shell for the signed-in student. Keys force a clean remount when the user changes. */
export function Root() {
  const { state, refresh, signOut } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const signedInAs = state.status === 'signed-in' ? state.session.profile.id : null;

  useEffect(() => {
    if (!signedInAs) return;
    const persona = workspaceDemoPersona();
    identifyDemo(persona);
    capture('workspace_signed_in', { target: currentEngineTarget().kind, demo: persona ?? undefined });
  }, [signedInAs]);

  const recheck = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  if (state.status === 'checking') return <BootSplash />;
  if (state.status === 'signed-out') return <SignInView />;

  const { session } = state;
  // A read/export-only session (expired entitlement, suspended or withdrawn enrolment)
  // gets its own honest screen, not a dashboard full of clicks the engine would 403.
  const limitedReason = limitedReasonOf(session.access);
  if (limitedReason !== null) {
    return <LimitedAccessView reason={limitedReason} onSignOut={() => void signOut()} />;
  }

  // Admission is server-derived: anything other than an approval never reaches the dashboard.
  const admission = admissionOf(session.profile);
  if (!mayEnterDashboard(admission)) {
    return <AdmissionGate state={admission} onRefresh={recheck} onSignOut={() => void signOut()} refreshing={refreshing} />;
  }

  return (
    <NavProvider key={session.profile.id}>
      <ChatProvider profileId={session.profile.id}>
        <App profileId={session.profile.id} />
      </ChatProvider>
    </NavProvider>
  );
}
