import type { ProviderConfig } from '@sef/shared';
import { ollamaHeaders } from '../models/registry';

const EMBED_TIMEOUT_MS = 30_000;
/** Texts per HTTP call — bounded so one request never holds the whole corpus. */
export const EMBED_BATCH = 24;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, `Embeddings endpoint answered HTTP ${res.status}`);
  return res.json();
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * The embeddings endpoint for each provider kind — a plain HTTP client, not a chat model.
 * Anthropic has no embeddings API, so that kind reports unavailable; the caller turns any
 * failure into the keyword-only lane rather than a crash.
 */
export async function embedTexts(provider: ProviderConfig, model: string, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  switch (provider.kind) {
    case 'ollama': {
      const base = trimSlash(provider.baseUrl ?? 'http://localhost:11434');
      const headers = ollamaHeaders(provider);
      try {
        const res = (await postJson(`${base}/api/embed`, { model, input: texts }, headers)) as { embeddings?: number[][] };
        if (!Array.isArray(res.embeddings) || res.embeddings.length !== texts.length) {
          throw new Error('Ollama /api/embed returned a short or malformed batch');
        }
        return res.embeddings;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        // Older Ollama only serves the single-text /api/embeddings.
        const out: number[][] = [];
        for (const text of texts) {
          const res = (await postJson(`${base}/api/embeddings`, { model, prompt: text }, headers)) as { embedding?: number[] };
          if (!Array.isArray(res.embedding)) throw new Error('Ollama /api/embeddings returned no vector');
          out.push(res.embedding);
        }
        return out;
      }
    }
    case 'openai-compatible':
    case 'openai': {
      if (!provider.baseUrl) throw new Error(`Provider "${provider.id}" needs a base URL`);
      const headers: Record<string, string> = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
      const res = (await postJson(`${trimSlash(provider.baseUrl)}/embeddings`, { model, input: texts }, headers)) as {
        data?: Array<{ embedding: number[]; index: number }>;
      };
      if (!Array.isArray(res.data) || res.data.length !== texts.length) {
        throw new Error('Embeddings endpoint returned a short or malformed batch');
      }
      return res.data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
    }
    case 'anthropic':
      throw new Error('Anthropic providers cannot serve embeddings');
  }
}
