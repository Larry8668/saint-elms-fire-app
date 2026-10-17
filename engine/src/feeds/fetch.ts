import { log } from '../config';
import { parseFeed, type ParsedItem } from './parse';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class FeedRefusal extends Error {
  constructor(
    message: string,
    readonly code: 'host_not_allowed' | 'not_https' | 'too_large' | 'http_error' | 'redirect_loop',
  ) {
    super(message);
  }
}

export type FetchOutcome = { status: 'not_modified' } | { status: 'ok'; items: ParsedItem[]; etag?: string; lastModified?: string };

export interface FetchRequest {
  url: string;
  /** Hosts of the enabled, consented feeds — the whole egress allowance for this poll. */
  allowedHosts: ReadonlySet<string>;
  etag?: string;
  lastModified?: string;
}

function checkUrl(raw: string, allowed: ReadonlySet<string>): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new FeedRefusal('Feeds are fetched over https only', 'not_https');
  if (!allowed.has(url.hostname.toLowerCase())) throw new FeedRefusal(`Host ${url.hostname} is not a consented feed host`, 'host_not_allowed');
  return url;
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new FeedRefusal('Feed is too large', 'too_large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new FeedRefusal('Feed is too large', 'too_large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * One conditional GET of one feed. Redirects are followed by hand so every hop is re-checked
 * against the allowlist; only the host is logged, never the path or query.
 */
export async function fetchFeed(request: FetchRequest, fetchImpl: FetchLike = fetch): Promise<FetchOutcome> {
  let url = checkUrl(request.url, request.allowedHosts);
  const started = Date.now();
  const headers: Record<string, string> = { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' };
  if (request.etag) headers['if-none-match'] = request.etag;
  if (request.lastModified) headers['if-modified-since'] = request.lastModified;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(url.toString(), { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get('location');
      if (!location) throw new FeedRefusal(`Redirect without a location (${res.status})`, 'http_error');
      url = checkUrl(new URL(location, url).toString(), request.allowedHosts);
      continue;
    }
    if (res.status === 304) {
      log.info('feed_fetch', { host: url.hostname, status: 304, ms: Date.now() - started });
      return { status: 'not_modified' };
    }
    if (!res.ok) throw new FeedRefusal(`Feed answered ${res.status}`, 'http_error');
    const items = parseFeed(await readCapped(res));
    log.info('feed_fetch', { host: url.hostname, status: res.status, ms: Date.now() - started, items: items.length });
    return { status: 'ok', items, etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined };
  }
  throw new FeedRefusal('Too many redirects', 'redirect_loop');
}

export const hostOf = (url: string) => new URL(url).hostname.toLowerCase();
