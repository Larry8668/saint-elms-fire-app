import type { AttentionItem, SignalKind } from '@sef/shared';
import { AlarmClock, BellOff, BookOpen, CalendarClock, Cpu, FileCheck, HelpCircle, Megaphone, RefreshCw, Users, WifiOff, Wrench, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, Tooltip } from '@/components/ui/overlays';
import { Badge } from '@/components/ui/primitives';
import { RowListSkeleton } from '@/components/ui/skeletons';
import { cn } from '@/lib/cn';
import { useNav } from '@/lib/nav';
import { useAttention, useAttentionActions } from '@/lib/queries';
import { destination, dueLabel, KIND_LABEL, SNOOZE_OPTIONS, unseenKeys } from './attention';

const KIND_ICON: Record<SignalKind, LucideIcon> = {
  deadline: CalendarClock,
  notice: Megaphone,
  release_update: BookOpen,
  share_incoming: Users,
  proposal_pending: FileCheck,
  vault_question: HelpCircle,
  maintenance_finding: Wrench,
  model_unavailable: Cpu,
  connectivity: WifiOff,
};

const URGENCY_TONE = { urgent: 'rose', soon: 'gold', info: 'neutral' } as const;

export function AttentionSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const attention = useAttention();
  const actions = useAttentionActions();
  const items = attention.data?.items ?? [];

  // Opening the rail is looking at it: whatever was new is now seen, but keeps its
  // "new" mark for this visit so the student can still tell which items arrived.
  const unseen = unseenKeys(items).join('|');
  const markSeen = actions.seen.mutate;
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!open) return setArrived(new Set());
    if (!unseen) return;
    const keys = unseen.split('|');
    setArrived((previous) => new Set([...previous, ...keys]));
    markSeen(keys);
  }, [open, unseen, markSeen]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Needs your attention">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
        <div>
          <div className="text-sm font-semibold text-night-100">Needs your attention</div>
          {attention.data?.quiet && <div className="text-[11.5px] text-night-400">Quiet hours — only deadlines under a day are highlighted.</div>}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip content="Check again now">
            <Button variant="ghost" size="icon" aria-label="Check again now" loading={actions.evaluate.isPending} onClick={() => actions.evaluate.mutate()}>
              <RefreshCw />
            </Button>
          </Tooltip>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={() => onOpenChange(false)}>
            <X />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {attention.isPending ? (
          <RowListSkeleton rows={4} />
        ) : attention.data && !attention.data.nudges ? (
          <p className="flex items-center gap-2 text-[13px] text-night-400">
            <BellOff className="size-4" /> Nudges are off. Turn them on in Settings.
          </p>
        ) : items.length ? (
          <ul className="space-y-2.5">
            {items.map((item) => (
              <AttentionRow key={item.key} item={item} isNew={item.state === 'new' || arrived.has(item.key)} onNavigate={() => onOpenChange(false)} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-night-400">Nothing needs you right now.</p>
        )}
      </div>
    </Sheet>
  );
}

function AttentionRow({ item, isNew, onNavigate }: { item: AttentionItem; isNew: boolean; onNavigate: () => void }) {
  const { go } = useNav();
  const { dismiss, snooze } = useAttentionActions();
  const [snoozing, setSnoozing] = useState(false);
  const Icon = KIND_ICON[item.kind];
  const target = destination(item);
  const due = dueLabel(item.dueAt, new Date());

  return (
    <li className={cn('rounded-xl border p-3.5', item.highlight && item.urgency === 'urgent' ? 'border-rose-400/30 bg-rose-400/[0.04]' : 'border-white/[0.07] bg-white/[0.02]')}>
      <div className="flex items-start gap-3">
        <Tooltip content={<span className="text-xs">Why: {item.why}</span>}>
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-beacon-300" aria-label={`Why: ${item.why}`}>
            <Icon className="size-4" />
          </span>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13.5px] font-medium text-night-100">{item.title}</span>
            {isNew && <Badge tone="beacon">new</Badge>}
            {due && <Badge tone={URGENCY_TONE[item.urgency]}>{due}</Badge>}
          </div>
          {item.detail && <p className="mt-0.5 text-[12px] leading-5 text-night-400">{item.detail}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {target && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  go(target.view, target.params);
                  onNavigate();
                }}
              >
                Open {KIND_LABEL[item.kind].toLowerCase()}
              </Button>
            )}
            {snoozing ? (
              SNOOZE_OPTIONS.map((option) => (
                <Button key={option.hours} size="sm" variant="ghost" onClick={() => snooze.mutate({ key: item.key, hours: option.hours })}>
                  {option.label}
                </Button>
              ))
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setSnoozing(true)}>
                <AlarmClock /> Snooze
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(item.key)}>
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}
