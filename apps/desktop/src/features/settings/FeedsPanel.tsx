import type { Feed } from '@sef/shared';
import { ExternalLink, Plus, Rss, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Switch, Tooltip } from '@/components/ui/overlays';
import { Badge, Eyebrow, Input, Panel } from '@/components/ui/primitives';
import { RowListSkeleton } from '@/components/ui/skeletons';
import { cn } from '@/lib/cn';
import { useFeedActions, useFeeds } from '@/lib/queries';
import { feedStatus, hostOf, originLabel, safeHref } from './feeds';

const MAX_HEADLINES = 5;

/**
 * Subject feeds. Unlike the rest of Settings this applies at once: switching a feed on *is*
 * the consent that lets the engine contact that site, so it should not wait for Save.
 */
export function FeedsPanel() {
  const feeds = useFeeds();
  const actions = useFeedActions();
  const [url, setUrl] = useState('');

  const add = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    actions.add.mutate({ url: trimmed }, { onSuccess: () => setUrl('') });
  };

  const list = feeds.data?.feeds ?? [];
  const titles = new Map(list.map((f) => [f.id, f.title]));
  const headlines = (feeds.data?.items ?? []).slice(0, MAX_HEADLINES);

  return (
    <section>
      <Eyebrow className="mb-3">Subject feeds</Eyebrow>
      <Panel className="space-y-4 p-5">
        <p className="text-[12.5px] leading-5 text-night-400">
          News from sources you trust — mission updates, preprint lists, department blogs — as quiet headlines and Philosopher suggestions. Only the title, summary and link are kept; articles are never downloaded.{' '}
          <span className="text-night-300">Nothing is fetched until you switch a feed on.</span> Changes here apply immediately.
        </p>

        <form onSubmit={add} className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… RSS or Atom address" aria-label="Feed address" className="flex-1" />
          <Button type="submit" variant="ghost" size="sm" disabled={!url.trim() || actions.add.isPending}>
            <Plus /> Add feed
          </Button>
        </form>

        {feeds.isPending ? (
          <RowListSkeleton rows={2} />
        ) : list.length === 0 ? (
          <div className="text-[12.5px] text-night-500">No feeds yet. Your course may add some when it syncs.</div>
        ) : (
          <ul className="space-y-2" aria-label="Feeds">
            {list.map((feed) => (
              <FeedRow
                key={feed.id}
                feed={feed}
                busy={actions.consent.isPending || actions.remove.isPending}
                onConsent={(enabled) => actions.consent.mutate({ id: feed.id, enabled })}
                onRemove={() => actions.remove.mutate(feed.id)}
              />
            ))}
          </ul>
        )}

        {headlines.length > 0 && (
          <div>
            <div className="mb-2 text-[11.5px] tracking-wide text-night-500 uppercase">Latest headlines</div>
            <ul className="space-y-1.5">
              {headlines.map((item) => {
                const href = safeHref(item);
                return (
                  <li key={item.id} className="flex items-baseline gap-2 text-[12.5px]">
                    <span className="shrink-0 text-night-500">{titles.get(item.feedId) ?? 'Feed'}</span>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-night-200 hover:text-night-100 hover:underline">
                        {item.title} <ExternalLink className="inline size-3 text-night-500" />
                      </a>
                    ) : (
                      <span className="min-w-0 truncate text-night-200">{item.title}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>
    </section>
  );
}

function FeedRow({ feed, busy, onConsent, onRemove }: { feed: Feed; busy: boolean; onConsent: (enabled: boolean) => void; onRemove: () => void }) {
  const status = feedStatus(feed);
  const host = hostOf(feed.url);
  return (
    <li className="flex items-center gap-3 rounded-lg border border-white/[0.06] px-3 py-2.5">
      <Rss className="size-4 shrink-0 text-night-500" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-night-100">{feed.title}</span>
          <Badge tone={feed.origin === 'uni' ? 'gold' : 'neutral'}>{originLabel(feed)}</Badge>
        </div>
        <div className={cn('truncate text-[12px]', status.tone === 'warn' ? 'text-gold-300' : status.tone === 'ok' ? 'text-night-400' : 'text-night-500')}>
          {host} · {status.text}
        </div>
      </div>
      <Tooltip content={feed.enabled ? `Stop fetching from ${host}` : `Allow fetching headlines from ${host}`}>
        <span>
          <Switch checked={feed.enabled} disabled={busy} onCheckedChange={onConsent} aria-label={`Allow fetching from ${host}`} />
        </span>
      </Tooltip>
      {feed.origin === 'student' && (
        <Tooltip content="Remove this feed and its headlines">
          <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} aria-label={`Remove ${feed.title}`}>
            <Trash2 />
          </Button>
        </Tooltip>
      )}
    </li>
  );
}
