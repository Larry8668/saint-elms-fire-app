import { serve } from '@hono/node-server';
import { createApp } from './app';
import { config } from './config';
import { loadCourseware } from './courseware';
import { errorFields, log } from './logger';
import { loadReleases } from './releases';
import { ShareStore } from './shares';
import { loadSigningKeys } from './signing';

async function main() {
  const [courseware, releases, keys] = await Promise.all([loadCourseware(), loadReleases(), loadSigningKeys()]);
  const shares = new ShareStore();
  await shares.load();
  const app = createApp({ courseware, releases, keys, shares });
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('uni_server_listening', { url: `http://${config.host}:${info.port}`, issuer: config.issuer });
  });
}

main().catch((error) => {
  log.error('uni_server_boot_failed', errorFields(error));
  process.exit(1);
});
