import type { AdminShareView } from '@sef/shared';
import { AlertTriangle, Archive, ChevronRight, Inbox, Paperclip, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlays';
import { Badge, EmptyState, Input, Label, Panel, Select, Skeleton, SkeletonText } from '@/components/ui/primitives';
import { timeAgo } from '@/lib/time';
import { useCohorts, useLegacyShares, usePublishedShare, usePublishedShares, useRemovePublishedShare, useRemoveShare } from '../admin-queries';
import { QueryState, TabHeader } from '../ui';

const STATE_TONE = { published: 'aurora', withdrawn: 'neutral', removed: 'ember' } as const;

/**
 * Share moderation. The top surface is the authenticated cohort feed's moderation
 * view; the quarantined pre-admission relay stays listed below it, clearly labelled,
 * until the last item is drained — it never feeds the student feed again.
 */
export function ModerationTab() {
  const [cohort, setCohort] = useState('');
  const [state, setState] = useState<'' | 'published' | 'withdrawn'>('');
  const [selected, setSelected] = useState<string | null>(null);
  const cohorts = useCohorts();
  const shares = usePublishedShares({ cohort: cohort || undefined, state: state || undefined });
  const items = useMemo(() => shares.data?.pages.flatMap((p) => p.items) ?? [], [shares.data]);

  return (
    <>
      <TabHeader
        title="Moderation"
        description="Everything students published to their cohorts — live and withdrawn. Removing a share stops it reaching anyone who has not imported it yet; copies already imported into a student's brain are theirs."
        actions={
          <>
            <Select value={cohort} onChange={(e) => setCohort(e.target.value)} aria-label="Filter by cohort">
              <option value="">All cohorts</option>
              {(cohorts.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Filter by state">
              <option value="">All states</option>
              <option value="published">Published</option>
              <option value="withdrawn">Withdrawn</option>
            </Select>
          </>
        }
      />

      {shares.isPending && (
        <div className="grid gap-3 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      )}
      {shares.isError && (
        <Panel className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <AlertTriangle className="size-6 text-ember-400" />
          <p className="max-w-sm text-sm text-night-300">{(shares.error as Error).message}</p>
          <Button size="sm" onClick={() => void shares.refetch()}>
            Retry
          </Button>
        </Panel>
      )}
      {shares.isSuccess &&
        (items.length ? (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((share) => (
                <PublishedShareCard key={share.id} share={share} onOpen={() => setSelected(share.id)} />
              ))}
            </div>
            {shares.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" size="sm" loading={shares.isFetchingNextPage} onClick={() => void shares.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyState icon={<Inbox />} title="Nothing to review" body="When students publish to their cohorts, shares appear here." />
        ))}

      <ShareDetail id={selected} onClose={() => setSelected(null)} />
      <QuarantineSection />
    </>
  );
}

function PublishedShareCard({ share, onOpen }: { share: AdminShareView; onOpen: () => void }) {
  return (
    <Panel className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-night-100">{share.payload.title}</h3>
          <div className="mt-0.5 text-[12px] text-night-500">
            {share.senderName} · {timeAgo(share.createdAt)} · rev {share.revision}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Badge tone="beacon">{share.cohortId}</Badge>
          <Badge tone={STATE_TONE[share.state] ?? 'neutral'}>{share.state}</Badge>
        </div>
      </div>
      <div className="mt-3 line-clamp-4 flex-1">
        <Markdown variant="chat" className="text-night-300">
          {share.payload.markdown}
        </Markdown>
      </div>
      {share.payload.attachments.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-night-500">
          <Paperclip className="size-3" /> {share.payload.attachments.length} attachment descriptor{share.payload.attachments.length === 1 ? '' : 's'} — contents stay on the student's device
        </div>
      )}
      {share.lastModeration && (
        <div className="mt-2 text-[12px] text-ember-300">
          Last action: {share.lastModeration.action} {timeAgo(share.lastModeration.occurredAt)}
          {share.lastModeration.note ? ` — ${share.lastModeration.note}` : ''}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" size="sm" onClick={onOpen}>
          Open <ChevronRight />
        </Button>
      </div>
    </Panel>
  );
}

/** Detail + event trail + removal. Removal needs a fresh staff session; a view-only bearer gets the server's honest refusal. */
function ShareDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = usePublishedShare(id);
  const remove = useRemovePublishedShare();
  const [note, setNote] = useState('');

  return (
    <Dialog open={Boolean(id)} onOpenChange={(open) => !open && onClose()} title="Share detail" description="The payload exactly as students' feeds carry it, plus the moderation trail.">
      {detail.isPending && <SkeletonText lines={6} />}
      {detail.isError && <Panel className="p-4 text-sm text-night-300">{(detail.error as Error).message}</Panel>}
      {detail.data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-night-400">
            <Badge tone="beacon">{detail.data.cohortId}</Badge>
            <Badge tone={STATE_TONE[detail.data.state] ?? 'neutral'}>{detail.data.state}</Badge>
            <span>
              {detail.data.senderName} · {detail.data.programmeId} · {timeAgo(detail.data.createdAt)} · rev {detail.data.revision}
            </span>
          </div>
          <Panel className="max-h-72 overflow-y-auto p-4">
            <Markdown variant="chat" className="text-night-300">
              {detail.data.payload.markdown}
            </Markdown>
          </Panel>
          {detail.data.payload.citations.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {detail.data.payload.citations.map((c, i) => (
                <Badge key={i} tone="neutral" title={c.url ?? c.locator ?? ''}>
                  {c.title}
                </Badge>
              ))}
            </div>
          )}
          {detail.data.payload.attachments.length > 0 && (
            <div className="space-y-1">
              {detail.data.payload.attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-[12px] text-night-500" title={`sha256 ${a.sha256}`}>
                  <Paperclip className="size-3" /> {a.name} · {a.mediaType} · {Math.ceil(a.bytes / 1024)} KB · descriptor only
                </div>
              ))}
            </div>
          )}
          {detail.data.events.length > 0 && (
            <div>
              <Label>Moderation trail</Label>
              <ul className="mt-1.5 space-y-1.5">
                {detail.data.events.map((event, i) => (
                  <li key={i} className="rounded-lg border border-white/[0.06] px-3 py-2 text-[12.5px] text-night-300">
                    <span className="font-medium text-night-100">{event.action}</span> by {event.actorSubject} · {timeAgo(event.occurredAt)}
                    {event.note ? ` — ${event.note}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.data.state === 'published' && (
            <div className="space-y-2 border-t border-white/[0.06] pt-4">
              <Label htmlFor="remove-note">Removal note (optional, kept in the trail)</Label>
              <div className="flex gap-2">
                <Input id="remove-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this share is coming down" />
                <Button
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() =>
                    remove.mutate(
                      { id: detail.data!.id, note: note.trim() || undefined },
                      {
                        onSuccess: () => {
                          setNote('');
                          onClose();
                        },
                      },
                    )
                  }
                >
                  <Trash2 /> Remove
                </Button>
              </div>
              <p className="text-[12px] text-night-500">
                Removal needs a fresh staff session — if this sign-in is too old the university will refuse honestly.
              </p>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * The pre-admission share relay, quarantined: it still exists, its items are listed
 * for review, but nothing here ever reaches the cohort feed and authors are never
 * re-attributed. Removing an item deletes it from the relay file store.
 */
function QuarantineSection() {
  const legacy = useLegacyShares();
  const remove = useRemoveShare();
  const items = legacy.data?.items ?? [];

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center gap-3">
        <Archive className="size-4 text-night-500" />
        <div>
          <h2 className="text-[15px] font-medium text-night-100">Legacy relay — quarantined</h2>
          <p className="text-[12.5px] text-night-500">
            Pre-admission shares kept for review. They never feed the cohort surface again; delete them as the review clears.
          </p>
        </div>
      </div>
      <QueryState
        query={legacy}
        skeleton={
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
        }
      >
        {() =>
          items.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((s) => (
                <Panel key={s.id} className="flex flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-medium text-night-100">{s.title}</h3>
                      <div className="mt-0.5 text-[12px] text-night-500">
                        {s.fromStudent} · {timeAgo(s.createdAt)}
                      </div>
                    </div>
                    <Badge tone="neutral">{s.cohortId}</Badge>
                  </div>
                  <div className="mt-3 max-h-32 flex-1 overflow-y-auto">
                    <Markdown variant="chat" className="text-night-300">
                      {s.markdown}
                    </Markdown>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <Button variant="danger" size="sm" loading={remove.isPending && remove.variables === s.id} onClick={() => remove.mutate(s.id)}>
                      <Trash2 /> Delete from relay
                    </Button>
                  </div>
                </Panel>
              ))}
            </div>
          ) : (
            <Panel className="px-5 py-8 text-center text-[13px] text-night-500">The quarantined relay is empty.</Panel>
          )
        }
      </QueryState>
    </section>
  );
}
