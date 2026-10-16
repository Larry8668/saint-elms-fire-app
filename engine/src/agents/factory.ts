import { Agent } from '@mastra/core/agent';
import type { ChatAttachment } from '@sef/shared';
import { z } from 'zod';
import { log } from '../config';
import { parsePartialJson } from '../lib/partial-json';
import { OLLAMA_OPTIONS, type ResolvedModel } from '../models/registry';
import { imageParts } from './messages';

type MastraTools = ConstructorParameters<typeof Agent>[0]['tools'];

export function makeAgent(id: string, instructions: string, resolved: ResolvedModel, tools?: MastraTools): Agent {
  return new Agent({ id, name: id, instructions, model: resolved.model, tools });
}

export class StructuredOutputError extends Error {}

export interface StructuredRequest<T extends z.ZodTypeAny> {
  agentId: string;
  instructions: string;
  resolved: ResolvedModel;
  prompt: string;
  images?: ChatAttachment[];
  schema: T;
}

const STRUCTURED_TIMEOUT_MS = 180_000;
const STRUCTURED_MAX_TOKENS = 2048;

/**
 * Ollama's native `format` takes a JSON schema and constrains decoding to it. In our
 * Gemma 4 E4B tests this was the difference between 0/3 and 3/3 valid outputs, so
 * structured calls to Ollama go straight to its API rather than through a generic adapter.
 */
/** Grammar-constrained decoding can fall into endless whitespace; this many in a row means it has. */
const WHITESPACE_LOOP = /\s{48}$/;

const GRAMMAR_HOSTILE_KEYS = new Set(['minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'default']);

/**
 * Size and range constraints make small models stall inside the grammar. The model
 * gets the shape only; the strict Zod schema is still enforced on what comes back.
 */
function grammarSchema(schema: z.ZodTypeAny): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([key]) => !GRAMMAR_HOSTILE_KEYS.has(key))
        .map(([key, value]) => [key, strip(value)]),
    );
  };
  return strip(z.toJSONSchema(schema));
}

async function ollamaStructured<T extends z.ZodTypeAny>(req: StructuredRequest<T>): Promise<unknown> {
  const base = (req.resolved.provider.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const think = Boolean((req.resolved.providerOptions.ollama as { think?: boolean } | undefined)?.think);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), STRUCTURED_TIMEOUT_MS);
  let content = '';
  let stopReason = 'stop';
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        model: req.resolved.modelId,
        stream: true,
        // Ollama 400s on `think` for models without a thinking mode, even when false.
        ...(think ? { think: true } : {}),
        format: grammarSchema(req.schema),
        options: { ...OLLAMA_OPTIONS, temperature: 0.2, repeat_penalty: 1.1, num_predict: STRUCTURED_MAX_TOKENS },
        messages: [
          { role: 'system', content: req.instructions },
          { role: 'user', content: req.prompt, images: req.images?.map((i) => i.data) },
        ],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { message?: { content?: string }; done?: boolean; done_reason?: string };
        content += event.message?.content ?? '';
        if (event.done) stopReason = event.done_reason ?? 'stop';
      }
      if (WHITESPACE_LOOP.test(content)) {
        stopReason = 'whitespace_loop';
        abort.abort();
        break;
      }
    }
  } catch (error) {
    if (stopReason !== 'whitespace_loop') throw error;
  } finally {
    clearTimeout(timer);
  }

  if (stopReason === 'stop') return JSON.parse(content);
  const recovered = parsePartialJson(content);
  log.warn('structured_output_recovered', {
    agent: req.agentId,
    reason: stopReason,
    chars: content.length,
    recovered: recovered !== null,
    stalledAt: content.trimEnd().slice(-160),
  });
  if (recovered === null) throw new StructuredOutputError(`Model output was cut off (${stopReason}) and could not be recovered`);
  return recovered;
}

async function mastraStructured<T extends z.ZodTypeAny>(req: StructuredRequest<T>): Promise<unknown> {
  const agent = makeAgent(req.agentId, req.instructions, req.resolved);
  const images = imageParts(req.images);
  const input = images.length ? [{ role: 'user', content: [{ type: 'text', text: req.prompt }, ...images] }] : req.prompt;
  const result = await agent.generate(input as never, {
    structuredOutput: { schema: req.schema },
    providerOptions: req.resolved.providerOptions as never,
    modelSettings: { temperature: 0.2, maxOutputTokens: STRUCTURED_MAX_TOKENS },
  });
  return result.object;
}

/**
 * Recovered output may end with a half-written array item. Drop items that fail
 * their element schema instead of rejecting the whole proposal.
 */
function lenientParse<T extends z.ZodTypeAny>(schema: T, raw: unknown) {
  const strict = schema.safeParse(raw);
  if (strict.success || !(schema instanceof z.ZodObject) || !raw || typeof raw !== 'object') return strict;
  const cleaned: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    const inner = field instanceof z.ZodDefault ? (field.def.innerType as z.ZodTypeAny) : field;
    if (inner instanceof z.ZodArray && Array.isArray(cleaned[key])) {
      const element = inner.element as z.ZodTypeAny;
      const maxItems = (z.toJSONSchema(inner) as { maxItems?: number }).maxItems;
      const valid = (cleaned[key] as unknown[]).filter((item) => element.safeParse(item).success);
      cleaned[key] = maxItems ? valid.slice(0, maxItems) : valid;
    }
  }
  return schema.safeParse(cleaned);
}

/** Schema-constrained generation, routed to the most reliable path for each provider. */
export async function generateStructured<T extends z.ZodTypeAny>(req: StructuredRequest<T>): Promise<{ object: z.infer<T>; ms: number }> {
  const started = Date.now();
  try {
    const raw = req.resolved.provider.kind === 'ollama' ? await ollamaStructured(req) : await mastraStructured(req);
    const parsed = lenientParse(req.schema, raw);
    if (!parsed.success) throw new StructuredOutputError(`Output did not match schema: ${parsed.error.issues[0]?.message}`);
    const ms = Date.now() - started;
    log.info('structured_generation', { agent: req.agentId, model: req.resolved.modelId, ms });
    return { object: parsed.data, ms };
  } catch (error) {
    log.warn('structured_generation_failed', { agent: req.agentId, model: req.resolved.modelId, ms: Date.now() - started, error: (error as Error).message });
    throw error instanceof StructuredOutputError ? error : new StructuredOutputError((error as Error).message);
  }
}
