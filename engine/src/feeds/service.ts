import { CONTRACT_VERSION, MAX_FEEDS, MAX_ITEMS_PER_FEED, type Feed, type FeedItem, type FeedsResponse, type SubjectFeedRef } from '@sef/shared';
import { errorFields, log } from '../config';
import { sha256Hex } from '../lib/hash';
import { FeedRefusal, fetchFeed, hostOf, type FetchLike } from './fetch';
import type { ParsedItem } from './parse';
import type { FeedLedger, FeedStore } from './store';

export const POLL_INTERVAL_MS = 15 * 60_000;
const DEAD_AFTER_FAILURES = 5;
const DEAD_AFTER_MS = 72 * 3_600_000;
const MAX_LISTED_ITEMS = 100;

export interface UniCourseFeeds {
  courseId: string;
  signedMetadata: boolean;
  subjectFeeds?: SubjectFeedRef[];
}

export interface FeedDeps {
  store: FeedStore;
  /** Installed courses; only signed metadata may contribute feeds. */
  courses: () => Promise<UniCourseFeeds[]>;
  fetch?: FetchLike;
  now?: () => Date;
}

export type AddResult = { ok: true; feed: Feed } | { ok: false; code: 'duplicate' | 'limit' };
export type RemoveResult = 'ok' | 'not_found' | 'uni_feed';

export const feedId = (url: string) => `feed_${sha256Hex(url.trim()).slice(0, 16)}`;
const itemId = (feed: string, item: ParsedItem) => `fi_${sha256Hex(`${feed}|${item.link || item.title}`).slice(0, 20)}`;
const itemTime = (item: FeedItem) => Date.parse(item.publishedAt ?? item.fetchedAt);
const titleFromUrl = (url: string) => hostOf(url).replace(/^www\./, '').slice(0, 120);

/** Fetching is allowed only for a feed the student (or a signed release) consented to and has not switched off. */
export const fetchable = (feed: Feed) => feed.enabled && feed.consentedAt !== null;

export function isDead(feed: Feed, now: Date): boolean {
  if (!fetchable(feed) || feed.failures < DEAD_AFTER_FAILURES) return false;
  const since = Date.parse(feed.lastSuccessAt ?? feed.addedAt);
  return now.getTime() - since >= DEAD_AFTER_MS;
}

/**
 * Subject feeds: a second consent-gated egress class beside web search. Offline or failing
 * feeds are skipped quietly — feeds are a nice-to-have, never an error.
 */
export class FeedService {
  constructor(private readonly deps: FeedDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async list(): Promise<FeedsResponse> {
    const ledger = await this.deps.store.read();
    const feeds = Object.values(ledger.feeds).sort((a, b) => a.origin.localeCompare(b.origin) || a.title.localeCompare(b.title));
    const items = feeds.flatMap((feed) => ledger.items[feed.id] ?? []).sort((a, b) => itemTime(b) - itemTime(a)).slice(0, MAX_LISTED_ITEMS);
    return { schemaVersion: CONTRACT_VERSION, feeds, items };
  }

  /** A student feed starts disabled and unconsented: no request is made until consent. */
  async add(url: string, title?: string): Promise<AddResult> {
    const now = this.now().toISOString();
    return this.deps.store.mutate((ledger): AddResult => {
      const id = feedId(url);
      if (ledger.feeds[id]) return { ok: false, code: 'duplicate' };
      if (Object.keys(ledger.feeds).length >= MAX_FEEDS) return { ok: false, code: 'limit' };
      const feed: Feed = { id, url: url.trim(), title: title ?? titleFromUrl(url), origin: 'student', consentedAt: null, enabled: false, addedAt: now, failures: 0 };
      ledger.feeds[id] = feed;
      log.info('feed_added', { feedId: id, host: hostOf(url), origin: 'student' });
      return { ok: true, feed };
    });
  }

  async setConsent(id: string, enabled: boolean): Promise<Feed | null> {
    const now = this.now().toISOString();
    return this.deps.store.mutate((ledger) => {
      const feed = ledger.feeds[id];
      if (!feed) return null;
      feed.enabled = enabled;
      if (enabled) feed.consentedAt = now;
      log.info('feed_consent', { feedId: id, host: hostOf(feed.url), enabled });
      return feed;
    });
  }

  /** Removing stops all fetching and clears the feed's items. Uni feeds are switched off instead. */
  async remove(id: string): Promise<RemoveResult> {
    return this.deps.store.mutate((ledger): RemoveResult => {
      const feed = ledger.feeds[id];
      if (!feed) return 'not_found';
      if (feed.origin === 'uni') return 'uni_feed';
      delete ledger.feeds[id];
      delete ledger.items[id];
      log.info('feed_removed', { feedId: id, host: hostOf(feed.url) });
      return 'ok';
    });
  }

  /**
   * Mirrors the feeds signed course metadata lists. Consent is implicit in the signed release
   * (`consentedAt` = first seen) but the student's off switch survives every later sync.
   */
  async syncUniFeeds(): Promise<void> {
    const courses = await this.deps.courses();
    const now = this.now().toISOString();
    const listed = new Map<string, { ref: SubjectFeedRef; courseId: string }>();
    for (const course of courses) {
      if (!course.signedMetadata) continue;
      for (const ref of course.subjectFeeds ?? []) listed.set(feedId(ref.url), { ref, courseId: course.courseId });
    }
    await this.deps.store.mutate((ledger) => {
      for (const [id, { ref, courseId }] of listed) {
        const existing = ledger.feeds[id];
        if (existing?.origin === 'uni') {
          existing.title = ref.title;
          existing.courseId = courseId;
          continue;
        }
        if (!existing && Object.keys(ledger.feeds).length >= MAX_FEEDS) continue;
        ledger.feeds[id] = {
          ...(existing ?? { failures: 0, addedAt: now }),
          id,
          url: ref.url,
          title: ref.title,
          origin: 'uni',
          courseId,
          consentedAt: existing?.consentedAt ?? now,
          enabled: existing?.enabled ?? true,
        };
        log.info('feed_added', { feedId: id, host: hostOf(ref.url), origin: 'uni', courseId });
      }
      for (const feed of Object.values(ledger.feeds)) {
        if (feed.origin !== 'uni' || listed.has(feed.id)) continue;
        delete ledger.feeds[feed.id];
        delete ledger.items[feed.id];
        log.info('feed_removed', { feedId: feed.id, host: hostOf(feed.url), origin: 'uni' });
      }
    });
  }

  /** One poll pass: due, fetchable feeds only, one at a time. Never throws. */
  async poll(): Promise<{ polled: number; newItems: number }> {
    try {
      await this.syncUniFeeds();
    } catch (error) {
      log.warn('feed_uni_sync_failed', errorFields(error));
    }
    const now = this.now();
    const ledger = await this.deps.store.read();
    const allowedHosts = new Set(Object.values(ledger.feeds).filter(fetchable).map((f) => hostOf(f.url)));
    const due = Object.values(ledger.feeds).filter((f) => fetchable(f) && (!f.lastFetchedAt || now.getTime() - Date.parse(f.lastFetchedAt) >= POLL_INTERVAL_MS));
    let newItems = 0;
    for (const feed of due) newItems += await this.pollOne(feed, allowedHosts, now);
    return { polled: due.length, newItems };
  }

  private async pollOne(feed: Feed, allowedHosts: ReadonlySet<string>, now: Date): Promise<number> {
    const stamp = now.toISOString();
    const held = ((await this.deps.store.read()).items[feed.id] ?? []).length > 0;
    // Validators only make sense while we still hold the items they vouch for.
    const validators = held ? { etag: feed.etag, lastModified: feed.lastModified } : {};
    let outcome: Awaited<ReturnType<typeof fetchFeed>> | undefined;
    let failure: string | undefined;
    try {
      outcome = await fetchFeed({ url: feed.url, allowedHosts, ...validators }, this.deps.fetch);
    } catch (error) {
      failure = error instanceof FeedRefusal ? error.code : 'unreachable';
      log.info('feed_fetch_skipped', { feedId: feed.id, host: hostOf(feed.url), reason: failure, ...(error instanceof FeedRefusal ? {} : errorFields(error)) });
    }
    return this.deps.store.mutate((ledger) => {
      const current = ledger.feeds[feed.id];
      // Removed or switched off while the request was in flight: keep nothing from it.
      if (!current || !fetchable(current)) return 0;
      current.lastFetchedAt = stamp;
      if (failure) {
        current.failures += 1;
        current.lastError = failure;
        return 0;
      }
      current.failures = 0;
      current.lastSuccessAt = stamp;
      delete current.lastError;
      if (outcome?.status !== 'ok') return 0;
      current.etag = outcome.etag?.slice(0, 200);
      current.lastModified = outcome.lastModified?.slice(0, 100);
      return mergeItems(ledger, feed.id, outcome.items, stamp);
    });
  }

  /** Recent items and dead feeds, for the attention rail and Philosopher seeds. */
  async snapshot(): Promise<{ items: Array<FeedItem & { feedTitle: string }>; dead: Feed[] }> {
    const ledger = await this.deps.store.read();
    const now = this.now();
    const feeds = Object.values(ledger.feeds).filter(fetchable);
    return {
      items: feeds.flatMap((feed) => (ledger.items[feed.id] ?? []).map((item) => ({ ...item, feedTitle: feed.title }))).sort((a, b) => itemTime(b) - itemTime(a)),
      dead: feeds.filter((feed) => isDead(feed, now)),
    };
  }
}

function mergeItems(ledger: FeedLedger, id: string, parsed: ParsedItem[], stamp: string): number {
  const known = new Map((ledger.items[id] ?? []).map((item) => [item.id, item]));
  let added = 0;
  for (const item of parsed) {
    const key = itemId(id, item);
    if (known.has(key)) continue;
    known.set(key, { id: key, feedId: id, title: item.title, summary: item.summary, link: item.link, publishedAt: item.publishedAt, fetchedAt: stamp });
    added += 1;
  }
  ledger.items[id] = [...known.values()].sort((a, b) => itemTime(b) - itemTime(a)).slice(0, MAX_ITEMS_PER_FEED);
  return added;
}
