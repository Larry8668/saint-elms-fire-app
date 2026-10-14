import type { ModelRole, ProviderConfig } from '@sef/shared';
import type { StoredSettings } from '../settings/store';

const TIMEOUT_MS = 2500;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Lists model ids a provider can serve. Used by settings and health. */
export async function listProviderModels(provider: ProviderConfig): Promise<string[]> {
  const base = (provider.baseUrl ?? '').replace(/\/+$/, '');
  switch (provider.kind) {
    case 'ollama': {
      const body = (await getJson(`${base || 'http://localhost:11434'}/api/tags`)) as { models?: Array<{ name: string }> };
      return (body.models ?? []).map((m) => m.name);
    }
    case 'openai-compatible':
    case 'openai': {
      const url = `${base || 'https://api.openai.com/v1'}/models`;
      const headers: Record<string, string> = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
      const body = (await getJson(url, headers)) as { data?: Array<{ id: string }> };
      return (body.data ?? []).map((m) => m.id);
    }
    case 'anthropic':
      return provider.apiKey ? ['claude-sonnet-4-5', 'claude-haiku-4-5'] : [];
  }
}

export async function checkRoles(settings: StoredSettings) {
  const roles: ModelRole[] = ['tutor', 'brain', 'vision'];
  const cache = new Map<string, Promise<string[]>>();
  return Promise.all(
    roles.map(async (role) => {
      const { provider: providerId, model } = settings.roles[role];
      const provider = settings.providers.find((p) => p.id === providerId);
      if (!provider) return { role, provider: providerId, model, reachable: false, detail: 'unknown provider' };
      if (!cache.has(provider.id)) cache.set(provider.id, listProviderModels(provider));
      try {
        const models = await cache.get(provider.id)!;
        const found = models.length === 0 || models.some((m) => m === model || m === `${model}:latest`);
        return { role, provider: provider.label, model, reachable: found, detail: found ? undefined : 'model not pulled' };
      } catch (error) {
        return { role, provider: provider.label, model, reachable: false, detail: (error as Error).message };
      }
    }),
  );
}
