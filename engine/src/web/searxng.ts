import { log } from '../config';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

const TIMEOUT_MS = 6000;

/** Self-hosted SearXNG: no API key, and search engines see the server, not the student. */
export async function webSearch(baseUrl: string, query: string, limit = 5): Promise<WebResult[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const results = (body.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, limit)
    .map((r) => ({ title: r.title!, url: r.url!, snippet: (r.content ?? '').slice(0, 400) }));
  log.info('web_search', { query, results: results.length });
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
