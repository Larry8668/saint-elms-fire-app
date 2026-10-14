import type { IngestResult } from '@sef/shared';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/overlays';
import { Skeleton } from '@/components/ui/primitives';
import { BrainDiff } from '@/features/brain/BrainDiff';

/** Shape of a brain diff, shown while the brain keeper is still reading. */
function BrainDiffSkeleton() {
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

interface ReflectDialogProps {
  open: boolean;
  startedAt?: number;
  result: IngestResult | null;
  onClose: () => void;
  onSeeSky: () => void;
}

export function ReflectDialog({ open, startedAt, result, onClose, onSeeSky }: ReflectDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={result ? 'Your brain grew' : 'Reflecting on this session'}
      description={result ? 'Proposed by the brain keeper, checked by the validator, written to markdown on this device.' : 'The brain keeper is reading the conversation and drafting page updates. Nothing is written until the validator approves it.'}
    >
      {result ? (
        <div className="space-y-5 animate-rise">
          <BrainDiff diff={result.diff} applied={result.applied} rejected={result.rejected} model={result.model} durationMs={result.durationMs} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Keep talking
            </Button>
            <Button variant="primary" onClick={onSeeSky}>
              See it in the sky <ArrowRight />
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <WorkingLabel label="Reading the session" startedAt={startedAt} className="text-gold-300" />
          <BrainDiffSkeleton />
        </div>
      )}
    </Dialog>
  );
}
