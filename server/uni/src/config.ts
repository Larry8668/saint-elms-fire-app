import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
};
