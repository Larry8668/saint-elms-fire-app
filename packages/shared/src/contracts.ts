import { z } from 'zod';

export const CONTRACT_VERSION = 2 as const;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export type ContractVersion = z.infer<typeof ContractVersionSchema>;

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export type Identifier = z.infer<typeof IdentifierSchema>;

export const RevisionSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value.trim() === value, 'Revision must be canonical');
export type Revision = z.infer<typeof RevisionSchema>;

export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

export const HttpUrlSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password;
}, 'URLs must not include credentials');
export type HttpUrl = z.infer<typeof HttpUrlSchema>;

export const IssuerUrlSchema = HttpUrlSchema.refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.search && !url.hash;
}, 'Issuer URL must not include a query or fragment');
export type IssuerUrl = z.infer<typeof IssuerUrlSchema>;

export const IdentifierListSchema = z
  .array(IdentifierSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate identifiers');
export type IdentifierList = z.infer<typeof IdentifierListSchema>;

export const NonemptyIdentifiersSchema = z
  .array(IdentifierSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate identifiers');
export type NonemptyIdentifiers = z.infer<typeof NonemptyIdentifiersSchema>;

export const ProfileIdentitySchema = z.strictObject({
  issuer: IssuerUrlSchema,
  studentId: IdentifierSchema,
  programmeId: IdentifierSchema,
});
export type ProfileIdentity = z.infer<typeof ProfileIdentitySchema>;

export const ContractErrorSchema = z.strictObject({
  schemaVersion: ContractVersionSchema,
  error: z.enum([
    'unauthenticated',
    'verification_required',
    'unapproved',
    'forbidden',
    'offline',
    'incompatible_schema',
    'unavailable',
    'conflict',
    'invalid_request',
  ]),
  message: z.string().min(1).max(500),
});
export type ContractError = z.infer<typeof ContractErrorSchema>;
