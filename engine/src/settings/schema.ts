import { z } from 'zod';

const RoleSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) });

const ProviderSchema = z.object({
  id: z.string().min(1).max(60),
  kind: z.enum(['ollama', 'openai-compatible', 'openai', 'anthropic']),
  label: z.string().min(1).max(80),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  hasApiKey: z.boolean().optional(),
});

/** What PUT /api/settings accepts. Unknown keys are stripped so stale or hostile fields never reach settings.json. */
export const SettingsPatchSchema = z
  .object({
    uniServerUrl: z.string().url(),
    searxngUrl: z.string().url(),
    providers: z.array(ProviderSchema).max(20),
    roles: z.object({ tutor: RoleSchema.optional(), brain: RoleSchema.optional(), vision: RoleSchema.optional(), embed: RoleSchema.optional() }),
    thinking: z.boolean(),
  })
  .partial();
