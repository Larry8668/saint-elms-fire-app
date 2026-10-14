import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelRole, ProviderConfig } from '@sef/shared';
import { createOllama } from 'ollama-ai-provider-v2';
import type { StoredSettings } from '../settings/store';

/** The AI SDK v5 model object every Mastra agent accepts. */
export type ChatModel = ReturnType<ReturnType<typeof createOllama>>;

export interface ResolvedModel {
  model: ChatModel;
  role: ModelRole;
  provider: ProviderConfig;
  modelId: string;
  /** Label for the "served by" chip, e.g. "gemma4:e4b · Ollama (on this device)". */
  label: string;
  /** Provider-specific options passed straight to Mastra (thinking, etc.). */
  providerOptions: Record<string, Record<string, unknown>>;
}

export class ModelConfigError extends Error {}

type ProviderFactory = (provider: ProviderConfig, modelId: string) => ChatModel;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * One factory per provider kind. Adding a provider means adding one entry here
 * and one option in settings — nothing else in the engine changes.
 */
const FACTORIES: Record<ProviderConfig['kind'], ProviderFactory> = {
  ollama: (provider, modelId) =>
    createOllama({ baseURL: `${trimSlash(provider.baseUrl ?? 'http://localhost:11434')}/api` })(modelId),
  'openai-compatible': (provider, modelId) => {
    if (!provider.baseUrl) throw new ModelConfigError(`Provider "${provider.id}" needs a base URL`);
    return createOpenAICompatible({
      name: provider.id,
      baseURL: trimSlash(provider.baseUrl),
      apiKey: provider.apiKey,
      supportsStructuredOutputs: true,
    })(modelId) as unknown as ChatModel;
  },
  openai: (provider, modelId) => {
    if (!provider.apiKey) throw new ModelConfigError('OpenAI needs an API key');
    return createOpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl })(modelId) as unknown as ChatModel;
  },
  anthropic: (provider, modelId) => {
    if (!provider.apiKey) throw new ModelConfigError('Anthropic needs an API key');
    return createAnthropic({ apiKey: provider.apiKey, baseURL: provider.baseUrl })(modelId) as unknown as ChatModel;
  },
};

/**
 * Ollama defaults to a 4K context, which silently truncates brain-keeper prompts and
 * makes thinking runs crawl. One fixed size for every call also avoids model reloads.
 */
export const OLLAMA_OPTIONS = {
  num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 12288),
  num_predict: Number(process.env.OLLAMA_NUM_PREDICT ?? 1200),
};

function providerOptionsFor(kind: ProviderConfig['kind'], think: boolean): Record<string, Record<string, unknown>> {
  if (kind === 'ollama') return { ollama: { think, options: OLLAMA_OPTIONS } };
  return {};
}

export function resolveModel(settings: StoredSettings, role: ModelRole, opts: { think?: boolean } = {}): ResolvedModel {
  const roleConfig = settings.roles[role];
  if (!roleConfig?.model) throw new ModelConfigError(`No model configured for role "${role}"`);
  const provider = settings.providers.find((p) => p.id === roleConfig.provider);
  if (!provider) throw new ModelConfigError(`Role "${role}" points at unknown provider "${roleConfig.provider}"`);
  const think = opts.think ?? false;
  return {
    model: FACTORIES[provider.kind](provider, roleConfig.model),
    role,
    provider,
    modelId: roleConfig.model,
    label: `${roleConfig.model} · ${provider.label}`,
    providerOptions: providerOptionsFor(provider.kind, think && settings.thinking),
  };
}
