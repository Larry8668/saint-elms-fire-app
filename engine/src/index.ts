import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { config, errorFields, log, profilePaths } from './config';
import { createCredentialStore } from './credentials/store';
import { bootstrapDemo } from './demo/bootstrap';
import { createApp } from './http/app';
import { edgeStartupCheck } from './http/edge';
import { AuthService } from './profiles/auth';
import { AnonymousDataManager } from './profiles/anonymous';
import { ProfileRegistry } from './profiles/registry';
import { enforceSeatOwner, SeatOwner } from './profiles/seat-owner';
import { AuthSessions } from './profiles/sessions';
import { WorkspaceManager } from './profiles/workspace';
import { SettingsStore } from './settings/store';
import { createObjectStore } from './store';
import { createVaultSync, parseVaultSyncConfig } from './sync';
import { startSignalScheduler } from './signals/scheduler';

async function main() {
  const edge = edgeStartupCheck(process.env, config.host);
  for (const warning of edge.warnings) log.warn('edge_config_warning', { warning });
  if (edge.errors.length > 0) {
    for (const error of edge.errors) log.error('edge_config_refused', { error });
    process.exit(1);
  }
  await mkdir(config.paths.trust, { recursive: true });

  const settings = new SettingsStore();
  const credentials = createCredentialStore();
  const registry = new ProfileRegistry(credentials);
  const workspaces = new WorkspaceManager(settings, registry);
  const sessions = new AuthSessions();
  const seat = SeatOwner.fromEnv(process.env);
  await enforceSeatOwner(seat, sessions);
  const auth = new AuthService(settings, registry, sessions, credentials, undefined, { seat });

  // Vault sync (PR-41b): off unless OBJECT_STORE_* and VAULT_SYNC_ACCOUNT are all set.
  const syncConfig = parseVaultSyncConfig(process.env, config.objectStore);
  for (const warning of syncConfig.warnings) log.warn('vault_sync_config_warning', { warning });
  const store = syncConfig.config ? createObjectStore(config.objectStore) : null;
  const vaultSync = syncConfig.config && store ? createVaultSync(syncConfig.config, store, profilePaths(syncConfig.config.account).root) : undefined;

  if (config.seedDemo) await bootstrapDemo(registry, workspaces);

  const app = createApp({ settings, auth, workspaces, anonymousData: new AnonymousDataManager(), vaultSync });
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('engine_listening', { url: `http://${config.host}:${info.port}`, data: config.paths.data, seedDemo: config.seedDemo, vaultSync: Boolean(vaultSync) });
  });
  startSignalScheduler(() => workspaces.opened());
  // Restore runs while liveness health answers `sync.state: 'restoring'`; /api/* waits for it.
  if (vaultSync) void vaultSync.sync.start();
}

main().catch((error) => {
  log.error('engine_boot_failed', errorFields(error));
  process.exit(1);
});
