import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createAccountAuth, resolveAccountAuthSecret, type AccountAuth } from './account-auth';
import { config } from './config';
import { loadCourseware, loadProgramme, programmeAvailability } from './courseware';
import { createDatabasePool, closeDatabasePool } from './db';
import { seedDemoAdmission } from './demo-admission';
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
import { InstaboxClient } from './instabox/client';
import { parseSessionConfig } from './sessions/config';
import { SessionOrchestrator } from './sessions/orchestrator';
import { SessionReaper } from './sessions/reaper';
import { sessionsTableReady } from './sessions/store';

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

  let sessions: SessionOrchestrator | null = null;
  let reaper: SessionReaper | null = null;
  const sessionConfig = parseSessionConfig(process.env, config.publicUrl);
  if (sessionConfig && !pool) {
    log.warn('session_orchestrator_disabled', { reason: 'UNI_DATABASE_URL is not set' });
  } else if (sessionConfig && pool) {
    if (!(await sessionsTableReady(pool))) {
      log.error('session_orchestrator_disabled', { reason: 'student_sessions is missing: run db:migrate' });
    } else {
      const client = new InstaboxClient({ apiKey: sessionConfig.apiKey, baseUrl: sessionConfig.apiBaseUrl });
      sessions = new SessionOrchestrator({ pool, client, config: sessionConfig });
      reaper = new SessionReaper(sessions, pool, client);
      await sessions.recover();
      reaper.start();
      log.info('session_orchestrator_enabled', {
        snapshot: sessionConfig.snapshotId,
        maxConcurrent: sessionConfig.maxConcurrent,
        idleMinutes: sessionConfig.idleMinutes,
        gatewayToken: Boolean(sessionConfig.gatewaySecret),
        objectStore: Object.keys(sessionConfig.objectStore).length > 0,
      });
    }
  }

  const availability = programme ? await programmeAvailability(programme) : undefined;
  const deps: UniDeps = { courseware, programme, availability, keys, releases, shares, accounts, audit, dispersal, accountAuth, pool, sessions };
  const firstBoot = await accounts.load();
  if (firstBoot && config.seedDemo) await seedUniDemo(deps);
  // Every boot, idempotently: the account store may survive while the database is new
  // (or vice versa), and Peers for the demo personas needs their admission rows.
  if (config.seedDemo && pool) {
    await seedDemoAdmission(pool).catch((error) => log.warn('demo_admission_seed_failed', errorFields(error)));
  }

  const app = createApp(deps);
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('uni_server_listening', { url: `http://${config.host}:${info.port}`, issuer: config.issuer, firstBoot, accountAuth: Boolean(accountAuth) });
  });

  const shutdown = () => {
    // In-flight spawns and teardowns resume from their rows on the next boot.
    void (reaper ? reaper.stop() : Promise.resolve())
      .then(() => (pool ? closeDatabasePool(pool) : undefined))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  log.error('uni_server_boot_failed', errorFields(error));
  process.exit(1);
});
