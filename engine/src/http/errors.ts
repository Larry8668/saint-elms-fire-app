import { SyncAuthError } from '../content/sync';
import { ModelConfigError } from '../models/registry';
import { UniUnreachableError } from '../uni/client';

/** Turns known error types into friendly messages the UI can show as-is. */
export function friendlyError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (error instanceof ModelConfigError || error instanceof SyncAuthError) return message;
  if (error instanceof UniUnreachableError) return 'The university server is unreachable. You can keep studying offline with what is already on this device.';
  if (/ECONNREFUSED|fetch failed|connect/i.test(message)) return 'Could not reach the model. Is Ollama running? Check Settings → Models.';
  if (/model\b.*\bnot found|try pulling/i.test(message)) return `Model not available: ${message}. Try "ollama pull" or pick another model in Settings.`;
  return message;
}

export function errorStatus(error: unknown): 400 | 401 | 503 | 500 {
  if (error instanceof ModelConfigError) return 400;
  if (error instanceof SyncAuthError) return 401;
  if (error instanceof UniUnreachableError) return 503;
  return 500;
}
