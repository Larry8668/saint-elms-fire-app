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

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A seat URL reduced to its origin: https, or plain http only on loopback (a local engine
 * under test). Credentials, a query or a fragment mean it is not a seat URL.
 */
export function normalizeSeatUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
    if (!secure || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The host to show for a seat URL, or null when it is not one; never throws. */
export function seatHost(engineUrl: string): string | null {
  const origin = normalizeSeatUrl(engineUrl);
  return origin ? new URL(origin).host : null;
}

/**
 * The stored seat, validated on every read. A record that is corrupt, from an older build or
 * not a seat URL is cleared and reads as no seat, so it can never break the sign-in screen.
 */
export function readSeat(store: Storage | null = storage()): SeatRecord | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(KEY) ?? null;
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<SeatRecord> | null;
    const engineUrl = typeof parsed?.engineUrl === 'string' ? normalizeSeatUrl(parsed.engineUrl) : null;
    if (engineUrl) {
      const machineId = typeof parsed?.machineId === 'string' && parsed.machineId ? parsed.machineId : undefined;
      return { engineUrl, ...(machineId ? { machineId } : {}) };
    }
  } catch {
    // Falls through to clearing the record.
  }
  try {
    store?.removeItem(KEY);
  } catch {
    // Storage that refuses writes still reads as no seat.
  }
  return null;
}

export function writeSeat(record: SeatRecord, store: Storage | null = storage()): void {
  const engineUrl = normalizeSeatUrl(record.engineUrl);
  if (!engineUrl) throw new Error('A seat URL must be https (or http on loopback).');
  store?.setItem(KEY, JSON.stringify({ engineUrl, ...(record.machineId ? { machineId: record.machineId } : {}) }));
}

export function forgetSeat(store: Storage | null = storage()): void {
  store?.removeItem(KEY);
}
