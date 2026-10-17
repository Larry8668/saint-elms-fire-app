import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAttention, useAttentionActions } from '@/lib/queries';
import { bannerItems, dueLabel } from './attention';

/** One line above every view for an urgent, unseen, policy-highlighted item. Silent otherwise. */
export function AttentionBanner({ onOpenRail }: { onOpenRail: () => void }) {
  const attention = useAttention();
  const { seen } = useAttentionActions();
  const [first, ...rest] = bannerItems(attention.data?.items ?? []);
  if (!first) return null;
  const due = dueLabel(first.dueAt, new Date());

  return (
    <div role="status" className="flex items-center gap-3 border-b border-rose-400/20 bg-rose-400/[0.06] px-6 py-2 text-[13px]">
      <AlertTriangle className="size-4 shrink-0 text-rose-400" />
      <button type="button" className="min-w-0 flex-1 truncate text-left text-night-100 hover:underline" onClick={onOpenRail}>
        {first.title}
        {due && <span className="text-night-400"> — {due}</span>}
        {rest.length > 0 && <span className="text-night-400"> · {rest.length} more</span>}
      </button>
      <Button variant="ghost" size="icon" aria-label="Hide this banner" onClick={() => seen.mutate([first.key, ...rest.map((item) => item.key)])}>
        <X />
      </Button>
    </div>
  );
}
