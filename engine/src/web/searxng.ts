import { log } from '../config';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/** Slightly above SearXNG's own max_request_timeout so slow engines are cut off there, not here. */
const TIMEOUT_MS = 9000;
const SNIPPET_CHARS = 400;

interface SearxResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
  /** Wikipedia answers as an infobox rather than a result. */
  infoboxes?: Array<{ infobox?: string; id?: string; content?: string }>;
}

/** Self-hosted SearXNG: no API key, and search engines see the server, not the student. */
export async function webSearch(baseUrl: string, query: string, limit = 5): Promise<WebResult[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1&language=en&categories=general,science`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const body = (await res.json()) as SearxResponse;

  const infoboxes = (body.infoboxes ?? [])
    .filter((b) => b.id?.startsWith('http') && b.infobox)
    .map((b) => ({ title: `${b.infobox} (Wikipedia)`, url: b.id!, snippet: b.content ?? '' }));
  const pages = (body.results ?? []).filter((r) => r.url && r.title).map((r) => ({ title: r.title!, url: r.url!, snippet: r.content ?? '' }));

  const seen = new Set<string>();
  const results = [...infoboxes, ...pages]
    .filter((r) => !seen.has(r.url) && seen.add(r.url))
    .slice(0, limit)
    .map((r) => ({ ...r, snippet: r.snippet.slice(0, SNIPPET_CHARS) }));
  log.info('web_search', { query, results: results.length, infoboxes: infoboxes.length });
  return results;
}

export async function webReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
