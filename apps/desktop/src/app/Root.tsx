import { lazy, Suspense, useCallback, useState } from 'react';
import { AdmissionGate } from '@/features/auth/AdmissionGate';
import { admissionOf, mayEnterDashboard } from '@/features/auth/admission';
import { limitedReasonOf } from '@/features/auth/limited-access';
import { LimitedAccessView } from '@/features/auth/LimitedAccessView';
import { SignInView } from '@/features/auth/SignInView';
import { ChatProvider } from '@/features/teachers/chat-store';
import { NavProvider } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { App } from './App';
import { BootSplash } from './BootSplash';

const AdminApp = lazy(() => import('@/features/admin/AdminApp').then((m) => ({ default: m.AdminApp })));

/** Picks the shell for whoever is signed in. Keys force a clean remount when the user changes. */
export function Root() {
  const { state, refresh, signOut } = useSession();
  const [refreshing, setRefreshing] = useState(false);

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
  if (session.kind === 'admin') {
    return (
      <Suspense fallback={<BootSplash label="Opening the registrar's desk" />}>
        <AdminApp key={session.account.id} />
      </Suspense>
    );
  }

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
        <App />
      </ChatProvider>
    </NavProvider>
  );
}
