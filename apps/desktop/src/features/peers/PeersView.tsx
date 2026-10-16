import type { PeerFeedItem, ShareImportResult } from '@sef/shared';
import { EyeOff, RefreshCw, Share2, Users, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { WorkingLabel } from '@/components/ui/loading';
import { Tabs } from '@/components/ui/overlays';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/primitives';
import { useNav } from '@/lib/nav';
import { timeAgo } from '@/lib/time';
import { ImportReview } from './ImportReview';
import { ShareDialog } from './ShareDialog';
import { ShareCard } from './ShareCard';
import { useIgnoreShare, useImportShare, useOwnShares, usePeerFeed, useWithdrawShare } from './peer-queries';

/**
 * The cohort floor: publish knowledge to the programme cohort, read what classmates
 * published, and pull peer material in through the normal source → proposal → review
 * pipeline. Network failures are honest empty states — the feed is never fabricated.
 */
export function PeersView() {
  const { sharePage } = useNav();
  const [tab, setTab] = useState<'feed' | 'mine'>('feed');
  const [shareOpen, setShareOpen] = useState(Boolean(sharePage));
  // A second "share this page" gesture while already on the view must reopen the dialog.
  useEffect(() => {
    if (sharePage) setShareOpen(true);
  }, [sharePage]);
  const [showIgnored, setShowIgnored] = useState(false);
  const [importResult, setImportResult] = useState<ShareImportResult | null>(null);

  const feed = usePeerFeed();
  const own = useOwnShares();
  const importShare = useImportShare();
  const withdraw = useWithdrawShare();
  const ignore = useIgnoreShare();

  const items = useMemo(() => feed.data?.pages.flatMap((p) => p.items) ?? [], [feed.data]);
  const visible = showIgnored ? items : items.filter((i) => !i.ignored);
  const feedState = feed.data?.pages[0]?.state;

  const runImport = (item: PeerFeedItem) => {
    importShare.mutate(item.id, { onSuccess: setImportResult });
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col overflow-y-auto px-6 py-6">
      <PageHeader
        eyebrow="cohort"
        title="Peers"
        description="Publish a page to your cohort, or import a classmate's share — imports land in your review queue, never straight in your brain."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void feed.refetch()} disabled={feed.isRefetching}>
              <RefreshCw className={feed.isRefetching ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShareOpen(true)}>
              <Share2 /> Share a page
            </Button>
          </div>
        }
      />

      <Tabs
        className="mt-5"
        value={tab}
        onValueChange={(v) => setTab(v as 'feed' | 'mine')}
        items={[
          { value: 'feed', label: 'Cohort feed' },
          {
            value: 'mine',
            label: (
              <span className="flex items-center gap-1.5">
                Shared by me {own.data ? <Badge tone="neutral">{own.data.items.length}</Badge> : null}
              </span>
            ),
          },
        ]}
      />

      {tab === 'feed' && (
        <div className="mt-5 space-y-4 pb-10">
          {feed.isPending && (
            <div className="grid place-items-center py-16">
              <WorkingLabel label="Asking the university…" />
            </div>
          )}

          {feedState && feedState !== 'ok' && (
            <EmptyState
              icon={<WifiOff className="size-6" />}
              title={feedState === 'offline' ? 'The university is unreachable' : feedState === 'auth_required' ? 'Sign in needed' : 'Feed unavailable'}
              body={feed.data?.pages[0]?.detail ?? 'The cohort feed is not available right now.'}
              action={
                <Button variant="secondary" size="sm" onClick={() => void feed.refetch()}>
                  <RefreshCw /> Try again
                </Button>
              }
            />
          )}

          {feedState === 'ok' && visible.length === 0 && (
            <EmptyState
              icon={<Users className="size-6" />}
              title="Nothing here yet"
              body={showIgnored ? 'No cohort shares yet. Be the first — share a page you found useful.' : 'Everything in your feed is hidden. Show hidden items to see them again.'}
            />
          )}

          {visible.length > 0 && (
            <div className="flex items-center justify-between text-[12px] text-night-500">
              <span>{feed.data?.pages[0]?.cohortId ? `Cohort ${feed.data.pages[0].cohortId}` : 'Your cohort'}</span>
              <button className="flex cursor-pointer items-center gap-1.5 hover:text-night-300" onClick={() => setShowIgnored((v) => !v)}>
                <EyeOff className="size-3.5" /> {showIgnored ? 'Hide dismissed items' : 'Show dismissed items'}
              </button>
            </div>
          )}

          {visible.map((item) => (
            <ShareCard
              key={`${item.id}@${item.revision}`}
              item={item}
              importing={importShare.isPending && importShare.variables === item.id}
              withdrawing={withdraw.isPending && withdraw.variables === item.id}
              onImport={() => runImport(item)}
              onWithdraw={() => withdraw.mutate(item.id)}
              onIgnore={(ignored) => ignore.mutate({ id: item.id, ignored })}
            />
          ))}

          {feed.hasNextPage && (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" size="sm" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      {tab === 'mine' && (
        <div className="mt-5 space-y-4 pb-10">
          {own.isPending && (
            <div className="grid place-items-center py-16">
              <WorkingLabel label="Checking your shares…" />
            </div>
          )}
          {own.data && (
            <>
              {!own.data.reachable && (
                <Panel className="border-ember-400/30 p-3 text-[13px] text-ember-200">
                  The university is unreachable — the states below are the last confirmed ones, not live.
                </Panel>
              )}
              {own.data.items.length === 0 && (
                <EmptyState icon={<Share2 className="size-6" />} title="You have not shared anything" body="Share a page and it will appear here, where you can withdraw it later." />
              )}
              {own.data.items.map((share) => (
                <Panel key={share.id} className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-[15px] font-medium text-night-100">{share.payload.title}</h3>
                      <div className="mt-0.5 text-[12px] text-night-500">
                        {timeAgo(share.createdAt)} · rev {share.revision}
                        {share.freshness === 'stored' && ' · last confirmed state'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={share.state === 'published' ? 'aurora' : 'ember'}>{share.state}</Badge>
                      {share.state === 'published' && (
                        <ConfirmButton
                          variant="danger"
                          size="sm"
                          confirmLabel="Withdraw?"
                          loading={withdraw.isPending && withdraw.variables === share.id}
                          disabled={share.freshness === 'stored'}
                          title={share.freshness === 'stored' ? 'Withdrawal needs the university online' : undefined}
                          onConfirm={() => withdraw.mutate(share.id)}
                        >
                          Withdraw
                        </ConfirmButton>
                      )}
                    </div>
                  </div>
                  {share.state === 'published' && (
                    <p className="mt-2 text-[12px] text-night-500">
                      Withdrawing stops future downloads. Classmates who already imported it keep their copy.
                    </p>
                  )}
                </Panel>
              ))}
            </>
          )}
        </div>
      )}

      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} initialPageId={sharePage} />
      {importResult && <ImportReview result={importResult} onClose={() => setImportResult(null)} />}
    </div>
  );
}
