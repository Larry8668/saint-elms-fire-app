import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Returns parsed JSON, or `fallback` when the file does not exist yet. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Atomic write (temp file + rename) so a crash never leaves half a JSON file behind. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`);
}

export async function readJsonLines<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
