import { defaultProactivity, mergeProactivity, type EngineSettings, type ProactivityPatch, type ProviderConfig } from '@sef/shared';
import { config, log, type ModelGateway } from '../config';
import { readJson, writeJson } from '../lib/fs';

export type StoredSettings = EngineSettings;
export type PrivateStoredSettings = Pick<StoredSettings, 'providers' | 'roles' | 'thinking' | 'proactivity'>;

export interface SettingsReader {
  get(): Promise<StoredSettings>;
}

/** A PUT body after validation: a role patch may name only some roles; unspecified ones keep their config. */
export type SettingsPatch = Omit<Partial<StoredSettings>, 'roles' | 'proactivity'> & {
  roles?: Partial<StoredSettings['roles']>;
  proactivity?: ProactivityPatch;
};

export interface SettingsSource extends SettingsReader {
  update(patch: SettingsPatch): Promise<StoredSettings>;
}

/** The provider a hosted session's gateway takes over; its label already reads "University model". */
export const GATEWAY_PROVIDER_ID = 'uni';

/** True for the provider that is the operator's model gateway on this engine (none on a laptop). */
export const isGatewayProvider = (provider: Pick<ProviderConfig, 'id'>, gateway: ModelGateway | null = config.modelGateway): boolean =>
  Boolean(gateway) && provider.id === GATEWAY_PROVIDER_ID;

/**
 * On a hosted session (MODEL_GATEWAY_URL set) the `uni` provider is the operator's model
 * gateway, spoken to over Ollama's native API, so every role keeps the tuning a local Ollama
 * gets (`num_ctx`, `think`, the `format` grammar). Its URL and token come from the environment
 * on every read and are never written to disk, so a rotated per-session token or a moved
 * gateway takes effect on the next engine start. The token travels as the provider's apiKey,
 * which native Ollama calls send as `Authorization: Bearer` (see `ollamaHeaders`).
 */
export function withGateway<T extends { providers: ProviderConfig[]; roles?: StoredSettings['roles'] }>(
  settings: T,
  gateway: ModelGateway | null = config.modelGateway,
): T {
  if (!gateway) return settings;
  const managed = (p: ProviderConfig): ProviderConfig => ({ ...p, kind: 'ollama', baseUrl: gateway.url, apiKey: gateway.token });
  const providers = settings.providers.map((p) => (p.id === GATEWAY_PROVIDER_ID ? managed(p) : p));
  if (!providers.some((p) => p.id === GATEWAY_PROVIDER_ID)) providers.push(managed({ id: GATEWAY_PROVIDER_ID, kind: 'ollama', label: 'University model' }));
  // A session box runs no Ollama: a role stored on it (a restored profile, say) uses the gateway.
  const roles = settings.roles
    ? (Object.fromEntries(
        Object.entries(settings.roles).map(([role, value]) => [role, value?.provider === 'ollama' ? { ...value, provider: GATEWAY_PROVIDER_ID } : value]),
      ) as StoredSettings['roles'])
    : undefined;
  return { ...settings, providers, ...(roles ? { roles } : {}) };
}

function defaultSettings(): StoredSettings {
  const d = config.defaults;
  // A session engine has no local model runtime: every role starts on the gateway.
  const roleProvider = config.modelGateway ? GATEWAY_PROVIDER_ID : 'ollama';
  return {
    uniServerUrl: d.uniServerUrl,
    searxngUrl: d.searxngUrl,
    thinking: true,
    providers: [
      { id: 'ollama', kind: 'ollama', label: 'Ollama (on this device)', baseUrl: d.ollamaUrl },
      // What a laptop stores; on a hosted session withGateway() overlays the gateway on every read.
      { id: GATEWAY_PROVIDER_ID, kind: 'openai-compatible', label: 'University model', baseUrl: 'http://localhost:11434/v1' },
    ],
    roles: {
      tutor: { provider: roleProvider, model: d.tutorModel },
      brain: { provider: roleProvider, model: d.brainModel },
      vision: { provider: roleProvider, model: d.visionModel },
      embed: { provider: roleProvider, model: d.embedModel },
      safety: { provider: roleProvider, model: d.safetyModel },
    },
    proactivity: defaultProactivity(),
  };
}

/** Device settings live in the engine data dir; student model settings use ProfileSettingsStore below. */
export class SettingsStore implements SettingsSource {
  private current: StoredSettings | null = null;

  constructor(private readonly filePath = config.paths.settings) {}

  async get(): Promise<StoredSettings> {
    if (!this.current) {
      const stored = await readJson<Partial<StoredSettings> | null>(this.filePath, null);
      const { studentName: _n, cohortId: _c, ...rest } = (stored ?? {}) as Partial<StoredSettings> & { studentName?: string; cohortId?: string };
      const defaults = defaultSettings();
      // Roles and proactivity merge over defaults so a file from before a field existed still gains it.
      this.current = {
        ...defaults,
        ...rest,
        roles: { ...defaults.roles, ...(rest.roles ?? {}) },
        proactivity: mergeProactivity(defaults.proactivity, rest.proactivity),
      };
      if (!stored) {
        await writeJson(this.filePath, this.current);
        log.info('settings_created', { file: this.filePath });
      }
    }
    return withGateway(this.current);
  }

  async update(patch: SettingsPatch): Promise<StoredSettings> {
    await this.get();
    // The stored copy, not the read view: a gateway token must never reach writeJson.
    const existing = this.current!;
    const providers = patch.providers ? mergeProviders(existing.providers, patch.providers) : existing.providers;
    this.current = {
      ...existing,
      ...patch,
      providers,
      roles: { ...existing.roles, ...(patch.roles ?? {}) },
      proactivity: mergeProactivity(existing.proactivity, patch.proactivity),
    };
    await writeJson(this.filePath, this.current);
    log.info('settings_updated', { fields: Object.keys(patch) });
    return withGateway(this.current);
  }

  /** Safe for the UI: keys replaced by a flag. */
  static redact(settings: StoredSettings): StoredSettings {
    return {
      ...settings,
      providers: settings.providers.map(({ apiKey, ...rest }) => ({ ...rest, hasApiKey: Boolean(apiKey) })),
    };
  }
}

/**
 * Per-profile model configuration and provider credentials. Device endpoint settings remain
 * shared so sign-in can select the university server before a student profile is known.
 */
export class ProfileSettingsStore implements SettingsSource {
  private current: PrivateStoredSettings | null = null;

  constructor(
    private readonly deviceSettings: SettingsStore,
    private readonly filePath: string,
  ) {}

  private async privateSettings(): Promise<PrivateStoredSettings> {
    if (!this.current) {
      const stored = await readJson<Partial<PrivateStoredSettings> | null>(this.filePath, null);
      const defaults = defaultSettings();
      this.current = {
        providers: stored?.providers ?? defaults.providers,
        roles: { ...defaults.roles, ...(stored?.roles ?? {}) },
        thinking: stored?.thinking ?? defaults.thinking,
        proactivity: mergeProactivity(defaults.proactivity, stored?.proactivity),
      };
    }
    return this.current;
  }

  async get(): Promise<StoredSettings> {
    const [device, privateSettings] = await Promise.all([this.deviceSettings.get(), this.privateSettings()]);
    return withGateway({ ...device, ...privateSettings });
  }

  async update(patch: SettingsPatch): Promise<StoredSettings> {
    const devicePatch: Partial<StoredSettings> = {};
    if (patch.uniServerUrl !== undefined) devicePatch.uniServerUrl = patch.uniServerUrl;
    if (patch.searxngUrl !== undefined) devicePatch.searxngUrl = patch.searxngUrl;
    if (Object.keys(devicePatch).length) await this.deviceSettings.update(devicePatch);

    const existing = await this.privateSettings();
    this.current = {
      providers: patch.providers ? mergeProviders(existing.providers, patch.providers) : existing.providers,
      roles: { ...existing.roles, ...(patch.roles ?? {}) },
      thinking: patch.thinking ?? existing.thinking,
      proactivity: mergeProactivity(existing.proactivity, patch.proactivity),
    };
    await writeJson(this.filePath, this.current);
    log.info('profile_settings_updated', { fields: Object.keys(patch).filter((field) => !['uniServerUrl', 'searxngUrl'].includes(field)) });
    return this.get();
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
