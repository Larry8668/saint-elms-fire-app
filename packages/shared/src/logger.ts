type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** JSON-lines logger: one event name plus structured fields, greppable in docker logs. */
export function createLogger(service: string, debugEnabled = false): Logger {
  const write = (level: Level, event: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, svc: service, event, ...fields });
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (event, fields) => debugEnabled && write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { error: error.message, stack: error.stack?.split('\n').slice(1, 4).map((l) => l.trim()).join(' | ') }
    : { error: String(error) };
}
