/**
 * Where this app's engine lives when it is a hosted seat. Not a secret: the URL and machine id
 * stay in this webview's storage and go nowhere else (never to the uni). The Instabox key is
 * not here; it lives in the OS keychain behind the Tauri shell.
 *
 * Minimal on purpose: the engine URL is read once at startup (lib/api.ts), so switching seats
 * reloads the window. A per-call seat store replaces this later.
 */
export interface SeatRecord {
  engineUrl: string;
  machineId?: string;
}

const KEY = 'sef.seat';

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** An https URL with nothing after the origin; anything else is not a seat. */
export function normalizeSeatUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readSeat(store: Storage | null = storage()): SeatRecord | null {
  try {
    const parsed = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<SeatRecord> | null;
    const engineUrl = parsed?.engineUrl ? normalizeSeatUrl(parsed.engineUrl) : null;
    return engineUrl ? { engineUrl, ...(parsed?.machineId ? { machineId: parsed.machineId } : {}) } : null;
  } catch {
    return null;
  }
}

export function writeSeat(record: SeatRecord, store: Storage | null = storage()): void {
  const engineUrl = normalizeSeatUrl(record.engineUrl);
  if (!engineUrl) throw new Error('A seat URL must be https.');
  store?.setItem(KEY, JSON.stringify({ engineUrl, ...(record.machineId ? { machineId: record.machineId } : {}) }));
}

export function forgetSeat(store: Storage | null = storage()): void {
  store?.removeItem(KEY);
}
