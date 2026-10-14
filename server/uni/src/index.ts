import { serve } from '@hono/node-server';
import { createApp } from './app';
import { config } from './config';
import { loadCourseware } from './courseware';
import { seedUniDemo } from './demo-seed';
import type { UniDeps } from './deps';
import { errorFields, log } from './logger';
import { loadSigningKeys } from './signing';
import { AccountStore } from './store/accounts';
import { AuditLog } from './store/audit';
import { DispersalStore } from './store/dispersal';
import { ReleaseStore } from './store/releases';
import { ShareStore } from './store/shares';

async function main() {
  const releases = new ReleaseStore();
  const shares = new ShareStore();
  const accounts = new AccountStore();
  const audit = new AuditLog();
  const dispersal = new DispersalStore();
  const [courseware, keys] = await Promise.all([
    loadCourseware(),
    loadSigningKeys(),
    releases.load(),
    shares.load(),
    audit.load(),
    dispersal.load(),
  ]);
  const deps: UniDeps = { courseware, keys, releases, shares, accounts, audit, dispersal };
  const firstBoot = await accounts.load();
  if (firstBoot) await seedUniDemo(deps);

  const app = createApp(deps);
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('uni_server_listening', { url: `http://${config.host}:${info.port}`, issuer: config.issuer, firstBoot });
  });
}

main().catch((error) => {
  log.error('uni_server_boot_failed', errorFields(error));
  process.exit(1);
});
