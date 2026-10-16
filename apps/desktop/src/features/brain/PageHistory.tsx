import { History, RotateCcw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlays';
import { Badge, Eyebrow, SkeletonText } from '@/components/ui/primitives';
import { pageBody } from '@/features/contribute/review';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { activeProfileKey, useInvalidateBrain, usePageRevision, usePageRevisions } from '@/lib/queries';
import { timeAgo } from '@/lib/time';

const shortRev = (revision: string) => (revision.length > 14 ? `${revision.slice(0, 12)}…` : revision);

/**
 * A page's committed past: every revision the vault ever wrote, readable back verbatim.
 * Restoring writes the old revision as a NEW one through the proposal pipeline — the
 * current page is archived first, and a stale base revision refuses rather than clobbering.
 */
export function PageHistory({ pageKey }: { pageKey: string }) {
  const revisions = usePageRevisions(pageKey);
  const [reading, setReading] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const content = usePageRevision(pageKey, reading);
  const savedAt = content.data ? revisions.data?.revisions.find((r) => r.revision === content.data!.revision)?.at : undefined;
  const invalidateBrain = useInvalidateBrain();
  const client = useQueryClient();

  const invalidatePage = () => {
    invalidateBrain();
    void client.invalidateQueries({ queryKey: [...activeProfileKey(), 'page-revisions', pageKey] });
    void client.invalidateQueries({ queryKey: [...activeProfileKey(), 'wiki-page', pageKey] });
  };

  const restore = useMutation({
    mutationFn: (revision: string) => {
      const base = revisions.data?.current;
      if (!base) throw new Error('The current revision is unknown — refresh before restoring.');
      return api.restorePage(pageKey, { revision, baseRevision: base });
    },
    onSuccess: (result, revision) => {
      invalidatePage();
      setRestored(revision);
      const changed = result.report.pages.filter((p) => p.change !== 'unchanged').length;
      toast.success(changed ? 'Restored — the page before it is kept in history.' : 'That revision is already what the page says.');
    },
    onError: (error) => {
      invalidatePage();
      toast.error((error as Error).message);
    },
  });

  if (!revisions.data || revisions.data.revisions.length === 0) return null;
  const current = revisions.data.current;

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
            onClick={() => {
              setReading(entry.revision);
              setRestored(null);
            }}
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
            {restored === reading && <Badge tone="gold">restored as the new revision</Badge>}
          </span>
        }
        description={savedAt ? `Saved ${timeAgo(savedAt)} — the page file exactly as it committed.` : undefined}
      >
        {content.isLoading && <SkeletonText lines={8} />}
        {content.data && (
          <div className="space-y-4">
            <Markdown variant="chat" className="text-[13.5px]">
              {pageBody(content.data.raw)}
            </Markdown>
            {!content.data.current && reading && (
              <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-3.5">
                <Button size="sm" variant="outline" loading={restore.isPending} disabled={!current} onClick={() => restore.mutate(reading)}>
                  <RotateCcw /> Restore this revision
                </Button>
                <p className="text-[11.5px] leading-5 text-night-500">
                  The page you have now is kept in history — restoring writes this revision on top as a new one,
                  and refuses if the page moved since you read it.
                </p>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </section>
  );
}
