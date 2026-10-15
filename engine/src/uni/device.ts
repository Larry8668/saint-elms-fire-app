import { z } from 'zod';
import { uniFetch, UniHttpError } from './client';

/**
 * RFC 8628 device authorization over the uni's better-auth device endpoints.
 * The engine holds the private device_code; the student confirms the user_code on
 * the uni-hosted page. Approval yields a regular uni session token.
 */
const CLIENT_ID = 'sef-engine';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const DeviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number(),
});

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export async function requestDeviceGrant(uniUrl: string): Promise<DeviceGrant> {
  const raw = await uniFetch<unknown>(uniUrl, '/v1/auth/device/code', {
    method: 'POST',
    body: { client_id: CLIENT_ID },
  });
  const parsed = DeviceCodeResponseSchema.safeParse(raw);
  if (!parsed.success) throw new UniHttpError(200, { error: 'device_grant_malformed' }, `${uniUrl}/v1/auth/device/code`);
  const r = parsed.data;
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verificationUri: r.verification_uri,
    verificationUriComplete: r.verification_uri_complete,
    expiresInSeconds: r.expires_in,
    intervalSeconds: r.interval,
  };
}

const DeviceTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

const DeviceErrorSchema = z.object({ error: z.string() });

export type DevicePoll =
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'approved'; sessionToken: string; expiresInSeconds: number }
  | { status: 'denied' }
  | { status: 'expired' };

export async function pollDeviceGrant(uniUrl: string, deviceCode: string): Promise<DevicePoll> {
  try {
    const raw = await uniFetch<unknown>(uniUrl, '/v1/auth/device/token', {
      method: 'POST',
      body: { grant_type: DEVICE_GRANT, device_code: deviceCode },
    });
    const parsed = DeviceTokenResponseSchema.safeParse(raw);
    if (!parsed.success) throw new UniHttpError(200, { error: 'device_token_malformed' }, `${uniUrl}/v1/auth/device/token`);
    return { status: 'approved', sessionToken: parsed.data.access_token, expiresInSeconds: parsed.data.expires_in };
  } catch (error) {
    if (!(error instanceof UniHttpError)) throw error;
    const code = DeviceErrorSchema.safeParse(error.body);
    switch (code.success ? code.data.error : '') {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'pending', slowDown: true };
      case 'access_denied':
        return { status: 'denied' };
      case 'expired_token':
        return { status: 'expired' };
      default:
        throw error;
    }
  }
}
