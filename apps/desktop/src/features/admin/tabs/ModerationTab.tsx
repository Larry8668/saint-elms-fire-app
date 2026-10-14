import { Inbox, Trash2 } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Panel, Skeleton } from '@/components/ui/primitives';
import { timeAgo } from '@/lib/time';
import { useRemoveShare, useShares } from '../admin-queries';
import { QueryState, TabHeader } from '../ui';

export function ModerationTab() {
  const shares = useShares();
  const remove = useRemoveShare();

  return (
    <>
      <TabHeader
        title="Moderation"
        description="Peer shares waiting on the relay. Students choose what enters their own brain; removing a share here stops it reaching anyone who hasn't pulled it yet."
      />
      <QueryState
        query={shares}
        skeleton={
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-44 rounded-2xl" />
            ))}
          </div>
        }
      >
        {(rows) =>
          rows.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {rows.map((s) => (
                <Panel key={s.id} className="flex flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-medium text-night-100">{s.title}</h3>
                      <div className="mt-0.5 text-[12px] text-night-500">
                        {s.fromStudent} · {timeAgo(s.createdAt)}
                      </div>
                    </div>
                    <Badge tone="beacon">{s.cohortId}</Badge>
                  </div>
                  <div className="mt-3 max-h-40 flex-1 overflow-y-auto">
                    <Markdown variant="chat" className="text-night-300">
                      {s.markdown}
                    </Markdown>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <Button variant="danger" size="sm" loading={remove.isPending && remove.variables === s.id} onClick={() => remove.mutate(s.id)}>
                      <Trash2 /> Remove
                    </Button>
                  </div>
                </Panel>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Inbox />} title="Nothing to review" body="When students share notes with their cohort, they appear here." />
          )
        }
      </QueryState>
    </>
  );
}
