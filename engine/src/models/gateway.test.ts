import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { ModelRole } from '@sef/shared';

// A hosted session as PR-42's orchestrator starts it: the OpenAI-style `/v1` URL plus a token.
const dataDir = await mkdtemp(path.join(tmpdir(), 'sef-gateway-models-'));
process.env.ENGINE_DATA_DIR = dataDir;
process.env.MODEL_GATEWAY_URL = 'https://gateway.example.test/v1';
process.env.MODEL_GATEWAY_TOKEN = 'sefgw1.secret-session-token';
const TOKEN = 'sefgw1.secret-session-token';

const { config, profilePaths } = await import('../config');
const { ProfileSettingsStore, SettingsStore } = await import('../settings/store');
const { isOnDevice, resolveModel } = await import('./registry');
const { checkRoles } = await import('./health');
const { embedTexts } = await import('../embed/client');
const { detectCapability } = await import('../system/capability');

const ROLES: ModelRole[] = ['tutor', 'brain', 'vision', 'embed', 'safety'];

interface Call {
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records every request and answers like the gateway (or a 401 when `status` says so). */
function stubFetch(answer: (url: string) => unknown, status = 200): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const authorization = new Headers(init?.headers).get('authorization');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, authorization, body });
    const payload = status === 200 ? answer(url) : { error: 'invalid or missing gateway token' };
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const chatAnswer = () => ({
  model: 'gemma4:e4b',
  created_at: new Date().toISOString(),
  message: { role: 'assistant', content: 'ok' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 3,
  eval_count: 1,
});

async function sessionSettings() {
  const device = new SettingsStore();
  return new ProfileSettingsStore(device, profilePaths('ananya').privateSettings);
}

test('the gateway URL resolves to its root, so the native /api surface is used', () => {
  assert.equal(config.modelGateway?.url, 'https://gateway.example.test');
});

test('in gateway mode every role resolves to the native Ollama provider at the gateway, with the bearer', async () => {
  const settings = await (await sessionSettings()).get();
  for (const role of ROLES) {
    const resolved = resolveModel(settings, role);
    assert.equal(resolved.provider.id, 'uni', role);
    assert.equal(resolved.provider.kind, 'ollama', role);
    assert.equal(resolved.provider.baseUrl, 'https://gateway.example.test', role);
    assert.equal(isOnDevice(resolved.provider), false, `${role} is not labelled on-device`);
    // The local-Ollama tuning travels with every role: the context size, and no `think` unless asked.
    const ollama = resolved.providerOptions.ollama as { think?: boolean; options?: { num_ctx?: number } };
    assert.equal(ollama.options?.num_ctx, 12288, role);
    assert.equal(ollama.think, undefined, `${role} does not think by default`);
  }
  assert.equal((resolveModel(settings, 'brain', { think: true }).providerOptions.ollama as { think?: boolean }).think, true);

  // A chat call goes to the gateway's /api/chat with the bearer and the native options.
  const calls = stubFetch(chatAnswer);
  const tutor = resolveModel(settings, 'tutor');
  await tutor.model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions: tutor.providerOptions as never,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://gateway.example.test/api/chat');
  assert.equal(calls[0]?.authorization, `Bearer ${TOKEN}`);
  assert.equal((calls[0]?.body?.options as { num_ctx?: number } | undefined)?.num_ctx, 12288);
  // The native provider sends `think: false` unless asked: the one switch gemma4's reasoning obeys.
  assert.equal(calls[0]?.body?.think, false);
});

test('embeddings use the gateway /api/embed with the bearer', async () => {
  const settings = await (await sessionSettings()).get();
  const embed = resolveModel(settings, 'embed');
  const calls = stubFetch(() => ({ embeddings: [[0.1, 0.2]] }));
  assert.deepEqual(await embedTexts(embed.provider, embed.modelId, ['alpha']), [[0.1, 0.2]]);
  assert.deepEqual(
    calls.map((c) => [c.url, c.authorization]),
    [['https://gateway.example.test/api/embed', `Bearer ${TOKEN}`]],
  );
});

test('the health probe uses the allowlisted /api/tags with the bearer, and never shows the token', async () => {
  const settings = await (await sessionSettings()).get();
  const ok = stubFetch(() => ({ models: [{ name: 'gemma4:e4b' }, { name: 'embeddinggemma:latest' }, { name: 'shieldgemma:2b' }] }));
  const healthy = await checkRoles(settings);
  assert.deepEqual([...new Set(ok.map((c) => c.url))], ['https://gateway.example.test/api/tags']);
  assert.ok(ok.every((c) => c.authorization === `Bearer ${TOKEN}`));
  assert.doesNotMatch(JSON.stringify(healthy), /secret-session-token/);

  stubFetch(() => null, 401);
  const refused = await checkRoles(settings);
  assert.ok(refused.every((r) => !r.reachable && r.detail === 'HTTP 401'));
  assert.doesNotMatch(JSON.stringify(refused), /secret-session-token/);
});

test('the token is never written to disk, and the redacted settings carry only a flag', async () => {
  const profile = await sessionSettings();
  await profile.update({ thinking: false });
  const files = await readdir(dataDir, { recursive: true });
  for (const file of files) {
    const full = path.join(dataDir, String(file));
    const text = await readFile(full, 'utf8').catch(() => '');
    assert.doesNotMatch(text, /secret-session-token/, `${file} holds no token`);
    assert.doesNotMatch(text, /gateway\.example\.test/, `${file} holds no gateway URL`);
  }
  const redacted = SettingsStore.redact(await profile.get());
  assert.doesNotMatch(JSON.stringify(redacted), /secret-session-token/);
  assert.equal(redacted.providers.find((p) => p.id === 'uni')?.hasApiKey, true);
});

test("a session VM's hardware sizes nothing: suggestions are the configured defaults", async () => {
  const capability = await detectCapability();
  assert.equal(capability.ramGb, null);
  assert.deepEqual(capability.suggested, { tutor: config.defaults.tutorModel, brain: config.defaults.brainModel, vision: config.defaults.visionModel, safety: config.defaults.safetyModel });
});
