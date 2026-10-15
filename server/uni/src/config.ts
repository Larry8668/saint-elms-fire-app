import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_PASSWORD_DEFAULT } from '@sef/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export const config = {
  port: Number(env('UNI_PORT', '4200')),
  host: env('UNI_HOST', '0.0.0.0'),
  issuer: env('UNI_ISSUER', 'Saint Elms University'),
  coursewareDir: path.resolve(env('COURSEWARE_DIR', path.join(serverRoot, '../../courseware'))),
  releasesFile: path.resolve(env('RELEASES_FILE', path.join(serverRoot, 'config/releases.json'))),
  keysDir: path.resolve(env('KEYS_DIR', path.join(serverRoot, 'keys'))),
  dataDir: path.resolve(env('UNI_DATA_DIR', path.join(serverRoot, '../../.data/uni'))),
  shareMaxBytes: Number(env('SHARE_MAX_BYTES', String(10 * 1024))),
  sharesPerDay: Number(env('SHARES_PER_DAY', '10')),
  /** Password given to the seeded admin and demo students on first boot. */
  demoPassword: env('DEMO_PASSWORD', DEMO_PASSWORD_DEFAULT),
  /** Student tokens are long-lived so devices can keep working offline between syncs. */
  studentTokenHours: Number(env('STUDENT_TOKEN_HOURS', String(24 * 30))),
  /** Offline entitlements renew daily so a suspension stops verified access within ~a day. */
  entitlementHours: Number(env('ENTITLEMENT_HOURS', '24')),
  adminTokenHours: Number(env('ADMIN_TOKEN_HOURS', '12')),
  /** Public origin of this server, used for account links and trusted-origin checks. */
  publicUrl: env('UNI_PUBLIC_URL', 'http://localhost:4200'),
  /** Additional origins accepted for account redirects (comma-separated). */
  extraTrustedOrigins: env('UNI_TRUSTED_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  /** When set, the better-auth account layer runs against this database. */
  databaseUrl: process.env.UNI_DATABASE_URL?.trim() || undefined,
};
