import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredSettings } from '../settings/store';
import { resolveModel } from '../models/registry';
import { ImageReadError, transcribeImage, VisionImageReader } from './vision';

const settings = (apiKey?: string) =>
  ({
    get: async () =>
      ({
        providers: [{ id: 'p', kind: 'ollama', label: 'Gateway', baseUrl: 'http://gateway.test/', ...(apiKey ? { apiKey } : {}) }],
        roles: { vision: { provider: 'p', model: 'gemma4:e4b' } },
      }) as StoredSettings,
  }) satisfies { get(): Promise<StoredSettings> };

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

test('an image is read through the native Ollama chat with the image attached and the gateway bearer sent', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ message: { content: '  F = ma\n' } }), { status: 200 });
  }) as unknown as typeof fetch;
  const resolved = resolveModel(await settings('session-token').get(), 'vision');
  const text = await transcribeImage(resolved, 'image/png', png, fetchFn);
  assert.equal(text, 'F = ma');
  assert.equal(calls[0]?.url, 'http://gateway.test/api/chat');
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, 'Bearer session-token');
  const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; stream: boolean; messages: Array<{ images?: string[] }> };
  assert.equal(body.model, 'gemma4:e4b');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages.at(-1)?.images, [Buffer.from(png).toString('base64')]);
});

test('the reader names a failure instead of inventing a reading', async () => {
  const reader = new VisionImageReader(settings(), async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const error = await reader.read(png, 'image/png').catch((e: unknown) => e);
  assert.ok(error instanceof ImageReadError);
  assert.equal(error.code, 'vision_failed');
  assert.match(error.message, /could not read this image/);

  const ok = new VisionImageReader(settings(), async () => 'p = mv');
  assert.deepEqual(await ok.read(png, 'image/png'), { text: 'p = mv' });
});
