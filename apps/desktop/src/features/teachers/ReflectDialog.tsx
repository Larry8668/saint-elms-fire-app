import { WorkingLabel } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/overlays';
import { Skeleton } from '@/components/ui/primitives';

/** Shape of a proposal draft, shown while the keeper is still reading. */
function DraftSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        {['w-20', 'w-28', 'w-24'].map((w) => (
          <Skeleton key={w} className={`h-5 rounded-full ${w}`} />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2 rounded-xl border border-white/[0.05] p-3.5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-4 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * The freeze + draft wait: the session's fresh turns are kept as a source and the keeper
 * drafts a proposal. The dialog closes into the review screen — the write itself is the
 * student's decision there, never this dialog's.
 */
export function ReflectDialog({ open, startedAt, onClose }: { open: boolean; startedAt?: number; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Reflecting on this session"
      description="The conversation is frozen as a kept source, then the brain keeper drafts page updates. What it proposes comes back to you for review."
    >
      <div className="space-y-5">
        <WorkingLabel label="Keeping the session, drafting changes" startedAt={startedAt} className="text-gold-300" />
        <DraftSkeleton />
      </div>
    </Dialog>
  );
}
