import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { readText, writeFileExclusive } from '../lib/fs';

/**
 * A stable random id for this device, generated once and persisted.
 * The uni binds offline entitlements to it (`dev` claim); it is not a secret.
 */
export async function deviceId(dataDir = config.paths.data): Promise<string> {
  const file = path.join(dataDir, 'device-id');
  const existing = await readText(file);
  if (existing?.trim()) return existing.trim();
  const id = randomUUID();
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFileExclusive(file, id);
  } catch {
    // Another engine process created it between our read and write — read theirs.
    const raced = await readText(file);
    if (raced?.trim()) return raced.trim();
  }
  return id;
}
