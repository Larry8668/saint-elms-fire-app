import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createAccountAuth, resolveAccountAuthSecret, type AccountAuth } from './account-auth';
import { config } from './config';
import { loadCourseware, loadProgramme, programmeAvailability } from './courseware';
import { createDatabasePool, closeDatabasePool } from './db';
import { seedUniDemo } from './demo-seed';
import type { UniDeps } from './deps';
import { errorFields, log } from './logger';
import { createMailer, parseMailConfig } from './mail';
import { assertSecondaryStorageReady } from './rate-limit';
import { loadSigningKeys } from './signing';
import { AccountStore } from './store/accounts';
import { AuditLog } from './store/audit';
import { DispersalStore } from './store/dispersal';
import { ReleaseStore } from './store/releases';
import { ShareStore } from './store/shares';
import type { Pool } from 'pg';

async function main() {
  const releases = new ReleaseStore();
  const shares = new ShareStore();
  const accounts = new AccountStore();
  const audit = new AuditLog();
  const dispersal = new DispersalStore();
  const [courseware, programme, keys] = await Promise.all([
    loadCourseware(),
    loadProgramme(),
    loadSigningKeys(),
    releases.load(),
    shares.load(),
    audit.load(),
    dispersal.load(),
  ]);

  let accountAuth: AccountAuth | null = null;
  let pool: Pool | undefined;
  if (config.databaseUrl) {
    pool = createDatabasePool();
    await assertSecondaryStorageReady(pool);
    accountAuth = createAccountAuth({
      pool,
      mail: createMailer(parseMailConfig()),
      publicUrl: config.publicUrl,
      secret: resolveAccountAuthSecret(),
      trustedOrigins: config.extraTrustedOrigins,
    });
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('UNI_DATABASE_URL is required in production');
  } else {
    log.warn('account_auth_disabled', { reason: 'UNI_DATABASE_URL is not set' });
  }

  const availability = programme ? await programmeAvailability(programme) : undefined;
  const deps: UniDeps = { courseware, programme, availability, keys, releases, shares, accounts, audit, dispersal, accountAuth, pool };
  const firstBoot = await accounts.load();
  if (firstBoot && config.seedDemo) await seedUniDemo(deps);

  const app = createApp(deps);
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('uni_server_listening', { url: `http://${config.host}:${info.port}`, issuer: config.issuer, firstBoot, accountAuth: Boolean(accountAuth) });
  });

  const shutdown = () => {
    void (pool ? closeDatabasePool(pool) : Promise.resolve()).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  log.error('uni_server_boot_failed', errorFields(error));
  process.exit(1);
});
