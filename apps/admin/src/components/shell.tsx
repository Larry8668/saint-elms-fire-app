import { useState, type ReactNode } from 'react';
import { Archive, LogOut, ScrollText, ShieldCheck, Users } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { ReauthBanner } from '@/components/reauth-banner';
import { WorkingLabel } from '@/components/ui/loading';
import { useSession } from '@/state/session-context';
import type { Route } from '@/state/use-hash-route';

const TABS: { view: Route['view']; hash: string; label: string; icon: typeof Users }[] = [
  { view: 'students', hash: '#/students', label: 'Students', icon: Users },
  { view: 'staff', hash: '#/staff', label: 'Staff', icon: ShieldCheck },
  { view: 'erasure', hash: '#/erasure', label: 'Erasure', icon: Archive },
  { view: 'audit', hash: '#/audit', label: 'Audit', icon: ScrollText },
];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { me, signOutNow } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await signOutNow();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-5 sm:px-6">
      <header className="flex flex-col gap-4 border-b border-white/[0.07] pb-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-2xl text-night-100">Registrar</span>
          <span className="text-[11px] font-semibold tracking-[0.18em] text-beacon-300 uppercase">Saint Elms University</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {me && (
            <div className="mr-1 flex min-w-0 flex-col items-start md:items-end">
              <span className="truncate text-[13px] text-night-200">{me.user.email}</span>
              <span className="flex flex-wrap gap-1.5">
                {me.staffRoles.map((role) => (
                  <Badge key={role} tone={role === 'owner' ? 'gold' : 'beacon'}>
                    {role}
                  </Badge>
                ))}
              </span>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => void signOut()} loading={signingOut} disabled={signingOut}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
        {signingOut && <WorkingLabel label="Signing out…" />}
      </header>

      <nav aria-label="Registrar sections" className="mt-4 -mb-px overflow-x-auto">
        <ul className="flex gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = route.view === tab.view;
            return (
              <li key={tab.view}>
                <a
                  href={tab.hash}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13.5px] font-medium transition-colors ${
                    active
                      ? 'bg-beacon-500/15 text-beacon-200 ring-1 ring-beacon-400/25 ring-inset'
                      : 'text-night-400 hover:bg-white/[0.05] hover:text-night-100'
                  }`}
                >
                  <Icon className="size-4" aria-hidden />
                  {tab.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-5">
        <ReauthBanner />
      </div>

      <main className="min-w-0 flex-1 pt-5">{children}</main>
    </div>
  );
}