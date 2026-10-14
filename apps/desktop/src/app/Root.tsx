import { lazy, Suspense } from 'react';
import { SignInView } from '@/features/auth/SignInView';
import { ChatProvider } from '@/features/teachers/chat-store';
import { NavProvider } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { App } from './App';
import { BootSplash } from './BootSplash';

const AdminApp = lazy(() => import('@/features/admin/AdminApp').then((m) => ({ default: m.AdminApp })));

/** Picks the shell for whoever is signed in. Keys force a clean remount when the user changes. */
export function Root() {
  const { state } = useSession();
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
  return (
    <NavProvider key={session.profile.id}>
      <ChatProvider profileId={session.profile.id}>
        <App />
      </ChatProvider>
    </NavProvider>
  );
}
