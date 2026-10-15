import { z } from 'zod';

const postgresUrl = z.string().trim().min(1).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
      && url.hostname.length > 0
      && url.username.length > 0
      && url.pathname.length > 1
      && url.hash.length === 0;
  } catch {
    return false;
  }
});

const configSchema = z.object({
  connectionString: postgresUrl,
  max: z.number().int().min(1).max(50),
  connectionTimeoutMillis: z.number().int().min(100).max(120_000),
  idleTimeoutMillis: z.number().int().min(0).max(600_000),
});

export interface DatabaseConfig {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  return Number(value);
}

export function parseDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = configSchema.safeParse({
    connectionString: environment.UNI_DATABASE_URL,
    max: numberFromEnv(environment.UNI_DB_POOL_MAX, 10),
    connectionTimeoutMillis: numberFromEnv(environment.UNI_DB_CONNECTION_TIMEOUT_MS, 5_000),
    idleTimeoutMillis: numberFromEnv(environment.UNI_DB_IDLE_TIMEOUT_MS, 30_000),
  });

  if (!parsed.success) throw new Error('Invalid UNI database configuration');
  return parsed.data;
}
