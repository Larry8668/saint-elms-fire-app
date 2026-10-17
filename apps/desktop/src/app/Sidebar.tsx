import { Bell, Brain, CalendarClock, FilePlus2, Library, MessagesSquare, Settings, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Tooltip } from '@/components/ui/overlays';
import { StatusDot } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useNav, type View } from '@/lib/nav';
import { useAttention, useHealth, useLint } from '@/lib/queries';
import { ProfileMenu } from './ProfileMenu';

const ITEMS: Array<{ view: View; label: string; Icon: LucideIcon }> = [
  { view: 'sky', label: 'Sky', Icon: Sparkles },
  { view: 'teachers', label: 'Teachers', Icon: MessagesSquare },
  { view: 'contribute', label: 'Add to my wiki', Icon: FilePlus2 },
  { view: 'brain', label: 'Brain', Icon: Brain },
  { view: 'peers', label: 'Peers', Icon: Users },
  { view: 'logistics', label: 'Logistics', Icon: CalendarClock },
  { view: 'library', label: 'Library', Icon: Library },
];

export function Sidebar({ onOpenAttention }: { onOpenAttention: () => void }) {
  const { view, go } = useNav();
  const health = useHealth();
  const lint = useLint();
  const attention = useAttention();
  const newItems = attention.data?.items.filter((item) => item.state === 'new').length ?? 0;
  const openQuestions = lint.data?.filter((f) => f.kind === 'misconception').length ?? 0;
  const modelsOk = health.data?.models ? health.data.models.every((m) => m.reachable) : undefined;

  return (
    <aside className="relative z-30 flex h-full w-[76px] shrink-0 flex-col items-center border-r border-white/[0.06] bg-night-950/70 py-4 backdrop-blur-xl">
      <img src="/logo.svg" alt="Saint Elms Fire" className="mb-6 size-9" />
      <nav className="flex flex-1 flex-col gap-1.5">
        {ITEMS.map(({ view: v, label, Icon }) => (
          <NavButton key={v} label={label} active={view === v} onClick={() => go(v)} badge={v === 'brain' ? openQuestions : 0}>
            <Icon className="size-[19px]" />
          </NavButton>
        ))}
      </nav>
      <div className="flex flex-col items-center gap-3">
        <NavButton label={newItems ? `Needs your attention (${newItems} new)` : 'Needs your attention'} active={false} onClick={onOpenAttention} badge={newItems}>
          <Bell className="size-[19px]" />
        </NavButton>
        <Tooltip
          side="right"
          content={
            <div className="space-y-1 text-xs">
              <Row label="Engine" ok={health.data?.ok ?? (health.isError ? false : undefined)} />
              <Row label="University" ok={health.data?.uni?.reachable} />
              {health.data?.models?.map((m) => <Row key={m.role} label={`${m.role} · ${m.model}`} ok={m.reachable} />)}
              <Row label="Web search" ok={health.data?.web?.reachable} />
            </div>
          }
        >
          <span className="grid size-8 place-items-center rounded-lg hover:bg-white/[0.05]">
            <StatusDot ok={health.isError ? false : modelsOk} pulse />
          </span>
        </Tooltip>
        <NavButton label="Settings" active={view === 'settings'} onClick={() => go('settings')}>
          <Settings className="size-[19px]" />
        </NavButton>
        <ProfileMenu />
      </div>
    </aside>
  );
}

function NavButton({ label, active, onClick, badge = 0, children }: { label: string; active: boolean; onClick: () => void; badge?: number; children: React.ReactNode }) {
  return (
    <Tooltip content={label} side="right">
      <button
        onClick={onClick}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn('relative grid size-11 place-items-center rounded-xl transition', active ? 'text-night-50' : 'text-night-500 hover:bg-white/[0.04] hover:text-night-200')}
      >
        {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl border border-white/10 bg-white/[0.07]" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
        <span className="relative">{children}</span>
        {badge > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-ember-400 shadow-[0_0_8px] shadow-ember-400" />}
      </button>
    </Tooltip>
  );
}

function Row({ label, ok }: { label: string; ok: boolean | undefined }) {
  return (
    <div className="flex items-center gap-2">
      <StatusDot ok={ok} /> <span className="text-night-200">{label}</span>
    </div>
  );
}
