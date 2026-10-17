import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineSettings, ProviderConfig, SharePayload } from '@sef/shared';
import type { SettingsReader } from '../settings/store';
import { defaultComplete, readScreeningAnswer, screeningPrompt, screeningText, ShareScreener, type SafetyComplete } from './screen';

const payload = (over: Partial<SharePayload> = {}): SharePayload => ({
  title: 'Tidal locking',
  markdown: 'The Moon keeps one face to Earth because tidal torquing settled it early.',
  citations: [],
  attachments: [],
  ...over,
});

const settingsWith = (roles: Partial<EngineSettings['roles']> = {}, providers: ProviderConfig[] = [{ id: 'ollama', kind: 'ollama', label: 'Ollama' }]): SettingsReader => ({
  get: async () =>
    ({
      providers,
      roles: roles as EngineSettings['roles'],
    }) as EngineSettings,
});

const screener = (opts: { roles?: Partial<EngineSettings['roles']>; providers?: ProviderConfig[]; complete?: SafetyComplete } = {}) =>
  new ShareScreener(settingsWith(opts.roles ?? { safety: { provider: 'ollama', model: 'shieldgemma:2b' } }, opts.providers), opts.complete);

test('the screened text is only the payload words — sender, cohort and ids never enter it', () => {
  const text = screeningText(
    payload({ attachments: [{ id: 'att_1', name: 'ring-tide-notes.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), bytes: 12 }] }),
  );
  assert.match(text, /Tidal locking/);
  assert.match(text, /tidal torquing/);
  assert.match(text, /ring-tide-notes\.pdf/, 'attachment names carry content and belong in the screen');
  const prompt = screeningPrompt(text);
  // The service never passes identity fields — assert the shape directly.
  assert.doesNotMatch(text, /sender|cohort|share_|att_1/i);
  assert.match(prompt, /<start_of_turn>/);
  assert.match(prompt, /harassment/);
  assert.match(prompt, /hate speech/);
  assert.match(prompt, /sexually explicit/);
  assert.match(prompt, /dangerous/);
  assert.match(prompt, /must start with "Yes" or "No"/);
});

test('the verdict parses the first token; categories come from named policies', () => {
  assert.deepEqual(readScreeningAnswer('No.', 'm'), { status: 'clean', categories: [], model: 'm' });
  assert.deepEqual(readScreeningAnswer('Yes — this is hate speech targeting a group.', 'm'), { status: 'flagged', categories: ['hate speech'], model: 'm' });
  assert.deepEqual(readScreeningAnswer('Yes. The text is harassment and dangerous.', 'm'), {
    status: 'flagged',
    categories: ['harassment', 'dangerous'],
    model: 'm',
  });
  assert.deepEqual(readScreeningAnswer('Yes', 'm'), { status: 'flagged', categories: [], model: 'm' }, 'a bare verdict still flags honestly');
  assert.equal(readScreeningAnswer('I cannot say either way.', 'm').status, 'unavailable', 'an unparsed answer is unavailable, never guessed');
});

test('a clean answer reports clean with the model named', async () => {
  const seen: string[] = [];
  const s = screener({
    complete: async (_provider, _model, prompt) => {
      seen.push(prompt);
      return 'No — nothing violates the policies.';
    },
  });
  const result = await s.screen(payload());
  assert.equal(result.status, 'clean');
  assert.equal(result.model, 'shieldgemma:2b');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /Tidal locking/, 'the payload text reached the prompt');
});

test('a flagged answer carries its categories into the result', async () => {
  const s = screener({ complete: async () => 'Yes — this is sexually explicit content.' });
  const result = await s.screen(payload());
  assert.equal(result.status, 'flagged');
  assert.deepEqual(result.categories, ['sexually explicit']);
});

test('no configured role, an unknown provider or a failed call all degrade to unavailable — never thrown', async () => {
  const noRole = screener({ roles: {} });
  assert.equal((await noRole.screen(payload())).status, 'unavailable');

  const badProvider = screener({ roles: { safety: { provider: 'ghost', model: 'x' } } });
  assert.equal((await badProvider.screen(payload())).status, 'unavailable');

  const failing = screener({
    complete: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const result = await failing.screen(payload());
  assert.equal(result.status, 'unavailable');
  assert.equal(result.model, 'shieldgemma:2b', 'the attempted model is still named');
});

test('the provider dispatch posts to each kind\'s own single-shot endpoint', async () => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: Object.fromEntries(Object.entries(init?.headers ?? {})) });
    const url = String(input);
    if (url.includes('api/chat')) return new Response(JSON.stringify({ message: { content: 'No.' } }));
    if (url.includes('chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'No.' } }] }));
    if (url.includes('/messages')) return new Response(JSON.stringify({ content: [{ type: 'text', text: 'No.' }] }));
    return new Response('{}', { status: 500 });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    assert.equal(await defaultComplete({ id: 'o', kind: 'ollama', label: 'O' }, 'm', 'p'), 'No.');
    assert.equal(await defaultComplete({ id: 'x', kind: 'openai-compatible', label: 'X', baseUrl: 'http://x.test/v1' }, 'm', 'p'), 'No.');
    assert.equal(await defaultComplete({ id: 'a', kind: 'anthropic', label: 'A', apiKey: 'k' }, 'm', 'p'), 'No.');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(calls[0]!.url, /\/api\/chat$/);
  assert.match(calls[1]!.url, /chat\/completions$/);
  assert.match(calls[2]!.url, /\/messages$/);
  assert.equal(calls[2]!.headers['x-api-key'], 'k', 'anthropic auth uses x-api-key, not Bearer');
});
