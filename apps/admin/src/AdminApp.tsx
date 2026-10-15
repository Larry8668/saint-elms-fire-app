import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { ErrorPanel } from '@/components/error-panel';
import { Shell } from '@/components/shell';
import { SignInCard } from '@/components/sign-in-card';
import { EmptyState, Panel } from '@/components/ui/primitives';
import { StudentTableSkeleton } from '@/components/ui/skeletons';
import { SessionProvider, useSession } from '@/state/session-context';
import { useHashRoute, type Route } from '@/state/use-hash-route';
import { AuditView } from '@/views/audit-view';
import { ErasureView } from '@/views/erasure-view';
import { StaffView } from '@/views/staff-view';
import { StudentDetailView } from '@/views/student-detail-view';
import { StudentsView } from '@/views/students-view';

/** Staff records are sensitive and short-lived in the browser: never cached across an account. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, retry: false, gcTime: 5 * 60_000 },
  },
});

export function AdminApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <Router />
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Router() {
  const session = useSession();
  const { route } = useHashRoute();

  if (session.status === 'checking') {
    return (
      <div className="mx-auto w-full max-w-3xl px-5 py-16">
        <StudentTableSkeleton rows={4} />
      </div>
    );
  }

  if (session.status === 'signed-out') {
    // A failed probe is not a signed-out person: say the server is unreachable instead.
    return session.probeError ? (
      <div className="mx-auto w-full max-w-lg px-5 py-16">
        <ErrorPanel error={session.probeError} onRetry={() => void session.refresh()} />
      </div>
    ) : (
      <SignInCard />
    );
  }

  if (session.status === 'not-staff') {
    return (
      <div className="mx-auto w-full max-w-lg px-5 py-16">
        <Panel>
          <EmptyState
            icon={<ShieldAlert />}
            title="This account has no staff access"
            body="You are signed in, but the university has not granted this account a staff membership, so no student records are shown here. An owner has to grant it with the staff:grant command."
            action={
              <button
                type="button"
                onClick={() => void session.signOutNow()}
                className="rounded-xl border border-white/10 px-4 py-2 text-[13px] text-night-200 hover:border-beacon-400/40"
              >
                Sign out
              </button>
            }
          />
        </Panel>
      </div>
    );
  }

  return <Shell route={route}>{renderView(route)}</Shell>;
}

/**
 * Filters live in the fragment, so the view is rebuilt on every hash change rather than memoised
 * on the view name: memoising here would freeze a student's list at the filters it was built with.
 */
function renderView(route: Route) {
  if (route.view === 'staff') return <StaffView />;
  if (route.view === 'erasure') return <ErasureView />;
  if (route.view === 'audit') return <AuditView />;
  return route.id ? <StudentDetailView profileId={route.id} key={route.id} /> : <StudentsView route={route} />;
}