import { errorFields, log } from '../config';

/**
 * Reads one optional input source. A failure is logged and becomes undefined, so callers can
 * tell "could not read" apart from "read, and empty" and avoid clearing what they knew.
 */
export async function attempt<T>(event: string, source: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    log.warn(event, { source, ...errorFields(error) });
    return undefined;
  }
}
