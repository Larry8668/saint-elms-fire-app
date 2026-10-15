import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { config, errorFields, log } from './config';
import { bootstrapDemo } from './demo/bootstrap';
import { createApp } from './http/app';
import { AuthService } from './profiles/auth';
import { AnonymousDataManager } from './profiles/anonymous';
import { ProfileRegistry } from './profiles/registry';
import { AuthSessions } from './profiles/sessions';
import { WorkspaceManager } from './profiles/workspace';
import { SettingsStore } from './settings/store';

async function main() {
  await mkdir(config.paths.trust, { recursive: true });

  const settings = new SettingsStore();
  const registry = new ProfileRegistry();
  const workspaces = new WorkspaceManager(settings, registry);
  const auth = new AuthService(settings, registry, new AuthSessions());

  if (config.seedDemo) await bootstrapDemo(registry, workspaces);

  const app = createApp({ settings, auth, workspaces, anonymousData: new AnonymousDataManager() });
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('engine_listening', { url: `http://${config.host}:${info.port}`, data: config.paths.data, seedDemo: config.seedDemo });
  });
}

main().catch((error) => {
  log.error('engine_boot_failed', errorFields(error));
  process.exit(1);
});
