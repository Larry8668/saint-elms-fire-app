import { Activity, BookOpen, GraduationCap, LayoutDashboard, LogOut, Rocket, ScrollText, ShieldAlert, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/primitives';
import { ProfileAvatar } from '@/features/auth/ProfileAvatar';
import { cn } from '@/lib/cn';
import { log } from '@/lib/log';
import { useAdminSession, useSession } from '@/lib/session';
import { createAdminApi } from './admin-api';
import { AdminApiProvider } from './admin-queries';
import { AuditTab } from './tabs/AuditTab';
import { CoursesTab } from './tabs/CoursesTab';
import { DispersalTab } from './tabs/DispersalTab';
import { ModerationTab } from './tabs/ModerationTab';
import { OverviewTab } from './tabs/OverviewTab';
import { ReleasesTab } from './tabs/ReleasesTab';
import { StudentsTab } from './tabs/StudentsTab';

const TABS = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard, Component: OverviewTab },
  { id: 'releases', label: 'Releases', Icon: Rocket, Component: ReleasesTab },
  { id: 'courses', label: 'Courses', Icon: BookOpen, Component: CoursesTab },
  { id: 'students', label: 'Students', Icon: GraduationCap, Component: StudentsTab },
  { id: 'dispersal', label: 'Dispersal', Icon: Activity, Component: DispersalTab },
  { id: 'moderation', label: 'Moderation', Icon: ShieldAlert, Component: ModerationTab },
  { id: 'audit', label: 'Audit log', Icon: ScrollText, Component: AuditTab },
] as const satisfies ReadonlyArray<{ id: string; label: string; Icon: LucideIcon; Component: ComponentType }>;

type TabId = (typeof TABS)[number]['id'];

const tabFromHash = (): TabId => {
  const id = window.location.hash.match(/^#\/admin\/([a-z]+)/)?.[1];
  return TABS.some((t) => t.id === id) ? (id as TabId) : 'overview';
};

/** Hash routing (`#/admin/releases`) so browser back/forward and deep links work like the student app. */
function useAdminTab() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  useEffect(() => {
    if (!window.location.hash.startsWith('#/admin/')) window.history.replaceState(null, '', `#/admin/${tab}`);
    const onPop = () => setTab(tabFromHash());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((next: TabId) => {
    log.info('admin_navigate', { tab: next });
    window.history.pushState(null, '', `#/admin/${next}`);
    setTab(next);
  }, []);
  return [tab, go] as const;
}

/** The registrar's desk: course dispersal and moderation, served by the uni server. */
export function AdminApp() {
  const session = useAdminSession();
  const { signOut } = useSession();
  const [tab, go] = useAdminTab();
  const api = useMemo(
    () =>
      createAdminApi(session.uniUrl, session.uniToken, () => {
        toast.info('Your registrar session expired. Please sign in again.');
        void signOut();
      }),
    [session.uniUrl, session.uniToken, signOut],
  );
  const Current = TABS.find((t) => t.id === tab)!.Component;

  return (
    <AdminApiProvider api={api}>
      <div className="flex h-screen overflow-hidden bg-night-950 text-night-100">
        <aside className="flex w-60 shrink-0 flex-col border-r border-white/[0.06] bg-night-950/70 p-4 backdrop-blur-xl">
          <div className="mb-6 flex items-center gap-2.5 px-2">
            <img src="/logo.svg" alt="" className="size-8" />
            <div>
              <div className="font-display text-xl leading-none">Registrar</div>
              <Eyebrow className="mt-1 text-[9.5px]">Saint Elms University</Eyebrow>
            </div>
          </div>
          <nav className="flex flex-1 flex-col gap-1">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => go(id)}
                className={cn('relative flex h-10 items-center gap-3 rounded-xl px-3 text-[13.5px] transition', tab === id ? 'text-night-50' : 'text-night-400 hover:bg-white/[0.04] hover:text-night-200')}
              >
                {tab === id && <motion.span layoutId="admin-nav" className="absolute inset-0 rounded-xl border border-white/10 bg-white/[0.07]" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                <Icon className="relative size-4" />
                <span className="relative">{label}</span>
              </button>
            ))}
          </nav>
          <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-white/[0.06] p-2.5">
            <ProfileAvatar id={session.account.id} name={session.account.name} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-night-100">{session.account.name}</div>
              <div className="truncate text-[11px] text-night-500">{session.account.email}</div>
            </div>
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}>
              <LogOut />
            </Button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="mx-auto max-w-6xl px-8 py-8">
            <Current />
          </motion.div>
        </main>
      </div>
    </AdminApiProvider>
  );
}
