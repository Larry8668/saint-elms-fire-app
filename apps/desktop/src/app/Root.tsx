import { useCallback, useState } from 'react';
import { AdmissionGate } from '@/features/auth/AdmissionGate';
import { admissionOf, mayEnterDashboard } from '@/features/auth/admission';
import { SignInView } from '@/features/auth/SignInView';
import { ChatProvider } from '@/features/teachers/chat-store';
import { NavProvider } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { App } from './App';
import { BootSplash } from './BootSplash';

/** Picks the shell for the signed-in student. Keys force a clean remount when the user changes. */
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

  // Admission is server-derived: anything other than an approval never reaches the dashboard.
  const { session } = state;
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
