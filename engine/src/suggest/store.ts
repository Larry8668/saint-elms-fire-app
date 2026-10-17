import path from 'node:path';
import { z } from 'zod';
import { SuggestionsResponseSchema, type SuggestionsResponse, type TeacherId } from '@sef/shared';
import { errorFields, log } from '../config';
import { readJson, writeJson } from '../lib/fs';

const CachedSchema = z.strictObject({
  version: z.literal(1),
  /** Hash of the ranked seed set; a change means the bank is regenerated. */
  fingerprint: z.string(),
  response: SuggestionsResponseSchema,
});
export type CachedSuggestions = z.infer<typeof CachedSchema>;

/**
 * Per-teacher suggestion cache, outside the vault (Friend suggestions can quote private
 * deadlines). Everything here is derived, so an unreadable file is just a cache miss.
 */
export class SuggestionStore {
  constructor(private readonly dir: string) {}

  private fileFor(teacher: TeacherId) {
    return path.join(this.dir, `suggestions-${teacher}.json`);
  }

  async read(teacher: TeacherId): Promise<CachedSuggestions | null> {
    try {
      const parsed = CachedSchema.safeParse(await readJson(this.fileFor(teacher), null));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      log.warn('suggestion_cache_unreadable', { teacher, ...errorFields(error) });
      return null;
    }
  }

  async write(teacher: TeacherId, fingerprint: string, response: SuggestionsResponse): Promise<void> {
    await writeJson(this.fileFor(teacher), { version: 1, fingerprint, response } satisfies CachedSuggestions);
  }
}
