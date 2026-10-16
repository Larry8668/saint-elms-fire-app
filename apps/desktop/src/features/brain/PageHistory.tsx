import { History } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Dialog } from '@/components/ui/overlays';
import { Badge, Eyebrow, SkeletonText } from '@/components/ui/primitives';
import { pageBody } from '@/features/contribute/review';
import { cn } from '@/lib/cn';
import { usePageRevision, usePageRevisions } from '@/lib/queries';
import { timeAgo } from '@/lib/time';

const shortRev = (revision: string) => (revision.length > 14 ? `${revision.slice(0, 12)}…` : revision);

/**
 * A page's committed past: every revision the vault ever wrote, readable back verbatim.
 * History is append-only — nothing here is a restore button, only the record.
 */
export function PageHistory({ pageKey }: { pageKey: string }) {
  const revisions = usePageRevisions(pageKey);
  const [reading, setReading] = useState<string | null>(null);
  const content = usePageRevision(pageKey, reading);
  const savedAt = content.data ? revisions.data?.revisions.find((r) => r.revision === content.data!.revision)?.at : undefined;

  if (!revisions.data || revisions.data.revisions.length === 0) return null;

  return (
    <section>
      <Eyebrow className="mb-2">
        <History className="mr-1 inline size-3" /> Page history
      </Eyebrow>
      <div className="flex flex-wrap gap-1.5">
        {revisions.data.revisions.map((entry) => (
          <button
            key={entry.revision}
            type="button"
            onClick={() => setReading(entry.revision)}
            className={cn(
              'cursor-pointer rounded-full border px-2.5 py-1 text-[11.5px] transition',
              entry.current ? 'border-aurora-400/30 bg-aurora-500/10 text-aurora-200' : 'border-white/[0.08] text-night-400 hover:border-white/[0.18] hover:text-night-200',
            )}
          >
            {entry.current ? 'current · ' : ''}
            {shortRev(entry.revision)} · {timeAgo(entry.at)}
          </button>
        ))}
      </div>

      <Dialog
        open={Boolean(reading)}
        onOpenChange={(open) => !open && setReading(null)}
        title={
          <span className="flex items-center gap-2">
            Revision {reading && shortRev(reading)}
            {content.data?.current && <Badge tone="aurora">current</Badge>}
          </span>
        }
        description={savedAt ? `Saved ${timeAgo(savedAt)} — the page file exactly as it committed.` : undefined}
      >
        {content.isLoading && <SkeletonText lines={8} />}
        {content.data && (
          <Markdown variant="chat" className="text-[13.5px]">
            {pageBody(content.data.raw)}
          </Markdown>
        )}
      </Dialog>
    </section>
  );
}
