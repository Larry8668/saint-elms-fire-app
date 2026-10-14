import type { EngineSettings, ProviderConfig } from '@sef/shared';
import { config, log } from '../config';
import { readJson, writeJson } from '../lib/fs';

export interface StoredSettings extends EngineSettings {
  cohortId: string;
}

function defaultSettings(): StoredSettings {
  const d = config.defaults;
  return {
    studentName: d.studentName,
    cohortId: d.cohortId,
    uniServerUrl: d.uniServerUrl,
    searxngUrl: d.searxngUrl,
    thinking: true,
    providers: [
      { id: 'ollama', kind: 'ollama', label: 'Ollama (on this device)', baseUrl: d.ollamaUrl },
      { id: 'uni', kind: 'openai-compatible', label: 'University model', baseUrl: 'http://localhost:11434/v1' },
    ],
    roles: {
      tutor: { provider: 'ollama', model: d.tutorModel },
      brain: { provider: 'ollama', model: d.brainModel },
      vision: { provider: 'ollama', model: d.visionModel },
    },
  };
}

/** Settings live in one JSON file in the engine data dir. API keys never leave the engine. */
export class SettingsStore {
  private current: StoredSettings | null = null;

  async get(): Promise<StoredSettings> {
    if (!this.current) {
      const stored = await readJson<Partial<StoredSettings> | null>(config.paths.settings, null);
      this.current = { ...defaultSettings(), ...stored } as StoredSettings;
      if (!stored) {
        await writeJson(config.paths.settings, this.current);
        log.info('settings_created', { file: config.paths.settings });
      }
    }
    return this.current;
  }

  async update(patch: Partial<StoredSettings>): Promise<StoredSettings> {
    const existing = await this.get();
    const providers = patch.providers ? mergeProviders(existing.providers, patch.providers) : existing.providers;
    this.current = { ...existing, ...patch, providers };
    await writeJson(config.paths.settings, this.current);
    log.info('settings_updated', { fields: Object.keys(patch) });
    return this.current;
  }

  /** Safe for the UI: keys replaced by a flag. */
  static redact(settings: StoredSettings): StoredSettings {
    return {
      ...settings,
      providers: settings.providers.map(({ apiKey, ...rest }) => ({ ...rest, hasApiKey: Boolean(apiKey) })),
    };
  }
}

/** An omitted or empty apiKey in an update keeps the stored key. */
function mergeProviders(existing: ProviderConfig[], incoming: ProviderConfig[]): ProviderConfig[] {
  return incoming.map((provider) => {
    const previous = existing.find((p) => p.id === provider.id);
    const { hasApiKey: _flag, ...rest } = provider;
    return { ...rest, apiKey: provider.apiKey?.trim() ? provider.apiKey.trim() : previous?.apiKey };
  });
}
