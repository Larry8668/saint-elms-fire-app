/** What a response reported (or what we estimated) — numbers only, never text. */
export interface Usage {
  tokens: number;
  estimated: boolean;
}

const MAX_LINE_CHARS = 8 * 1024 * 1024;

function reported(event: Record<string, unknown>): number | undefined {
  // Ollama native: the final chunk (or a non-streamed body) carries the counts.
  const p = event.prompt_eval_count;
  const e = event.eval_count;
  if (typeof p === 'number' || typeof e === 'number') return (typeof p === 'number' ? p : 0) + (typeof e === 'number' ? e : 0);
  // OpenAI-compatible: `usage` on the body, or on the last SSE chunk with include_usage.
  const usage = event.usage as Record<string, unknown> | null | undefined;
  if (usage && typeof usage === 'object') {
    if (typeof usage.total_tokens === 'number') return usage.total_tokens;
    const sum = (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
    if (sum) return sum;
  }
  return undefined;
}

/**
 * A side parser over the bytes the proxy forwards. It looks at NDJSON lines and SSE
 * `data:` lines only for usage counters; content fields are never read out or kept.
 * With no usage reported, the estimate is one token per streamed event plus a quarter
 * of the request bytes for the prompt.
 */
export class UsageMeter {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private events = 0;
  private found: number | undefined;

  constructor(private readonly requestBytes: number) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      this.consume(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
    // A single enormous line (a huge non-streamed body) is dropped rather than held.
    if (this.buffer.length > MAX_LINE_CHARS) this.buffer = '';
  }

  private consume(line: string): void {
    const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!data || data[0] !== '{') return;
    this.events++;
    try {
      const value = reported(JSON.parse(data) as Record<string, unknown>);
      if (value !== undefined) this.found = value;
    } catch {
      /* not JSON: still counted as an event */
    }
  }

  result(): Usage {
    if (this.buffer) this.consume(this.buffer);
    this.buffer = '';
    if (this.found !== undefined) return { tokens: this.found, estimated: false };
    return { tokens: Math.max(0, this.events - 1) + Math.ceil(this.requestBytes / 4), estimated: true };
  }
}
