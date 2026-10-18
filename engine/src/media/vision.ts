import { z } from 'zod';
import { generateStructured, makeAgent } from '../agents/factory';
import { errorFields, log } from '../config';
import { ModelConfigError, OLLAMA_OPTIONS, ollamaHeaders, resolveModel, type ResolvedModel } from '../models/registry';
import type { StoredSettings } from '../settings/store';

/**
 * Image reading: a photo of notes, a whiteboard or a printed page goes to the vision-role
 * model, which transcribes what is on it. On a device that is the local Ollama; on a hosted
 * session it is the model gateway (an ollama-kind provider whose session token rides as
 * `Authorization: Bearer` via `ollamaHeaders`). The model is asked to transcribe, never to
 * add — and an unreachable model is a named failure, never an invented reading.
 */

export const NotesReadingSchema = z.object({
  topic: z.string().describe('What the notes are about, in a few words'),
  transcription: z.string().describe('Faithful transcription of the handwritten or printed notes, including formulas in LaTeX'),
  concepts: z.array(z.string()).describe('Physics or maths concepts that appear in the notes'),
});

export type NotesReading = z.infer<typeof NotesReadingSchema>;

const READER_INSTRUCTIONS =
  "You read photos of a student's handwritten or printed study notes and transcribe them faithfully. Do not add content that is not on the page.";
const PLAIN_INSTRUCTIONS = `${READER_INSTRUCTIONS} Answer with the transcription only — no preamble, no commentary. Write formulas in LaTeX.`;
const READ_TIMEOUT_MS = 120_000;

/** Named failures the ingest path reports honestly — anything else is a bug and stays visible. */
export class ImageReadError extends Error {
  constructor(
    message: string,
    readonly code: 'vision_unavailable' | 'vision_failed',
  ) {
    super(message);
  }
}

/** What to ask of an image — the notes reader by default; a lecture frame asks differently. */
export interface ImageAsk {
  instructions: string;
  prompt: string;
}

const NOTES_ASK: ImageAsk = { instructions: PLAIN_INSTRUCTIONS, prompt: 'Transcribe these notes.' };

/**
 * A plain-text transcription. No grammar constraint: small vision models sometimes answer an
 * image with the transcription itself even when a JSON schema is requested, and a single
 * unconstrained call is also the quickest read.
 */
export async function transcribeImage(resolved: ResolvedModel, mediaType: string, bytes: Uint8Array, fetchFn: typeof fetch = fetch, ask: ImageAsk = NOTES_ASK): Promise<string> {
  const data = Buffer.from(bytes).toString('base64');
  if (resolved.provider.kind === 'ollama') {
    const base = (resolved.provider.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    const res = await fetchFn(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ollamaHeaders(resolved.provider) },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      body: JSON.stringify({
        model: resolved.modelId,
        stream: false,
        options: { ...OLLAMA_OPTIONS, temperature: 0.1 },
        messages: [
          { role: 'system', content: ask.instructions },
          { role: 'user', content: ask.prompt, images: [data] },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return (body.message?.content ?? '').trim();
  }
  const agent = makeAgent('notes-reader', ask.instructions, resolved);
  const result = await agent.generate(
    [{ role: 'user', content: [{ type: 'text', text: ask.prompt }, { type: 'image', image: data, mediaType }] }] as never,
    { providerOptions: resolved.providerOptions as never, modelSettings: { temperature: 0.1 } },
  );
  return result.text.trim();
}

/**
 * The structured read the "Read it again" action shows (topic + concepts). When the model
 * will not keep to the schema, the plain transcription stands in rather than failing.
 */
export async function readNotesImage(resolved: ResolvedModel, mediaType: string, bytes: Uint8Array): Promise<NotesReading> {
  try {
    const { object } = await generateStructured({
      agentId: 'notes-reader',
      instructions: READER_INSTRUCTIONS,
      resolved,
      prompt: 'Transcribe these notes.',
      images: [{ kind: 'image', mimeType: mediaType, data: Buffer.from(bytes).toString('base64') }],
      schema: NotesReadingSchema,
    });
    return object;
  } catch (error) {
    log.warn('image_structured_read_fell_back', errorFields(error));
    const transcription = await transcribeImage(resolved, mediaType, bytes);
    const firstLine = transcription.split('\n').find((line) => line.trim())?.trim() ?? '';
    return { topic: firstLine.slice(0, 80) || 'Notes', transcription, concepts: [] };
  }
}

/** What the ingest lane needs from a vision reader: the text on the image. */
export interface ImageReader {
  /** `ask` overrides the notes prompt — e.g. a lecture video's sampled frame. */
  read(bytes: Uint8Array, mediaType: string, ask?: ImageAsk): Promise<{ text: string }>;
}

/** The vision role's model, resolved per read so a settings change takes effect at once. */
export class VisionImageReader implements ImageReader {
  constructor(
    private readonly settings: { get(): Promise<StoredSettings> },
    private readonly transcribe: typeof transcribeImage = transcribeImage,
  ) {}

  async read(bytes: Uint8Array, mediaType: string, ask?: ImageAsk): Promise<{ text: string }> {
    let resolved: ResolvedModel;
    try {
      resolved = resolveModel(await this.settings.get(), 'vision');
    } catch (error) {
      if (error instanceof ModelConfigError) throw new ImageReadError(error.message, 'vision_unavailable');
      throw error;
    }
    const started = Date.now();
    try {
      const text = await this.transcribe(resolved, mediaType, bytes, fetch, ask);
      log.info('image_read', { model: resolved.modelId, ms: Date.now() - started, chars: text.length });
      return { text };
    } catch (error) {
      log.warn('image_read_failed', { model: resolved.label, ms: Date.now() - started, ...errorFields(error) });
      throw new ImageReadError(`The vision model (${resolved.label}) could not read this image right now. The photo is kept; read it again from the source once the model is reachable.`, 'vision_failed');
    }
  }
}
