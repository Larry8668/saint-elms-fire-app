import type { Feed, FeedItem } from '@sef/shared';

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const ago = (iso: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

/** One honest status line per feed: consent first, then the last thing that happened. */
export function feedStatus(feed: Feed, now = Date.now()): { text: string; tone: 'muted' | 'ok' | 'warn' } {
  if (!feed.consentedAt) return { text: 'Not fetched — switch on to allow requests to this site', tone: 'muted' };
  if (!feed.enabled) return { text: 'Switched off — nothing is fetched', tone: 'muted' };
  if (feed.failures >= 3) return { text: `Not responding (${feed.failures} tries) — will keep retrying quietly`, tone: 'warn' };
  if (feed.lastSuccessAt) return { text: `Checked ${ago(feed.lastSuccessAt, now)}`, tone: 'ok' };
  return { text: 'Waiting for the next check (every 15 minutes)', tone: 'muted' };
}

export const originLabel = (feed: Feed) => (feed.origin === 'uni' ? 'From your course' : 'Added by you');

/** Only http(s) links are ever rendered as links; anything else stays plain text. */
export function safeHref(item: FeedItem): string | null {
  try {
    const url = new URL(item.link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
