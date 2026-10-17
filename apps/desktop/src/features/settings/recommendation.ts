import type { DeviceCapability, EngineSettings, ModelRole, ModelRoleConfig, TieredRole } from '@sef/shared';

export const TIERED_ROLES: readonly TieredRole[] = ['tutor', 'brain', 'vision'];
export const DISMISS_KEY = 'sef.capability-card.dismissed';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export interface RoleSuggestion {
  role: TieredRole;
  current: string;
  suggested: string;
}

const sameModel = (a: string, b: string) => a.replace(/:latest$/, '') === b.replace(/:latest$/, '');

/** Suggestions are Ollama tags, so only roles served by an Ollama provider are sized to the device. */
export function suggestionFor(role: ModelRole, capability: DeviceCapability | undefined, settings: Pick<EngineSettings, 'providers' | 'roles'>): string | undefined {
  if (!capability || !(TIERED_ROLES as readonly ModelRole[]).includes(role)) return undefined;
  const provider = settings.providers.find((p) => p.id === settings.roles[role].provider);
  return provider?.kind === 'ollama' ? capability.suggested[role as TieredRole] : undefined;
}

/** Roles whose configured model differs from this device's suggestion. */
export function pendingSuggestions(capability: DeviceCapability, settings: Pick<EngineSettings, 'providers' | 'roles'>): RoleSuggestion[] {
  return TIERED_ROLES.flatMap((role) => {
    const suggested = suggestionFor(role, capability, settings);
    const current = settings.roles[role].model;
    return suggested && !sameModel(current, suggested) ? [{ role, current, suggested }] : [];
  });
}

/** Writes suggestions into the unsaved form only — the student still saves explicitly. */
export function applySuggestions(roles: Record<ModelRole, ModelRoleConfig>, suggestions: RoleSuggestion[]): Record<ModelRole, ModelRoleConfig> {
  const next = { ...roles };
  for (const { role, suggested } of suggestions) next[role] = { ...next[role], model: suggested };
  return next;
}

/** A dismissal covers this exact suggestion; a different device tier brings the card back. */
const fingerprint = (capability: DeviceCapability) => TIERED_ROLES.map((role) => capability.suggested[role]).join('|');

export function isCardDismissed(store: KeyValueStore | undefined, capability: DeviceCapability): boolean {
  try {
    return store?.getItem(DISMISS_KEY) === fingerprint(capability);
  } catch {
    return false;
  }
}

export function dismissCard(store: KeyValueStore | undefined, capability: DeviceCapability): void {
  try {
    store?.setItem(DISMISS_KEY, fingerprint(capability));
  } catch {
    // Storage may be unavailable (private mode, quota); the card simply reappears next visit.
  }
}

export function describeDevice(capability: DeviceCapability): string {
  const ram = capability.ramGb === null ? 'Memory unknown' : `${Math.round(capability.ramGb)} GB memory`;
  return capability.gpu ? `${ram} · ${capability.gpu}` : ram;
}
