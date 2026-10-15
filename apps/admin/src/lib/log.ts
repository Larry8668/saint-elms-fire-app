/** Structured client logs: event name plus fields, matching the engine's log style. */
export const log = {
  info: (event: string, fields?: Record<string, unknown>) => console.info(`[sef-admin] ${event}`, fields ?? ''),
  warn: (event: string, fields?: Record<string, unknown>) => console.warn(`[sef-admin] ${event}`, fields ?? ''),
  error: (event: string, fields?: Record<string, unknown>) => console.error(`[sef-admin] ${event}`, fields ?? ''),
};