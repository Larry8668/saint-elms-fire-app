/**
 * Fail-closed numeric environment parsing for service config. A port of "abc" or a
 * zero/negative duration must stop boot with a readable error, never drift into NaN
 * behaviour several layers down.
 */
export function envInt(
  name: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  // Digits only: '4.5', '-2', '1e3' and hex must all fail here rather than half-parse.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw.slice(0, 80))}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return value;
}

/** TCP ports from env: 1–65535, same failure contract as envInt. */
export function envPort(name: string, fallback: number, environment: NodeJS.ProcessEnv = process.env): number {
  return envInt(name, fallback, { min: 1, max: 65535 }, environment);
}
