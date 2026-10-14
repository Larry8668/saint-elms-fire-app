import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { BrainService } from './brain/service';
import { BrainVault } from './brain/vault';
import { config, errorFields, log } from './config';
import { ContentStore } from './content/store';
import { ContentSync } from './content/sync';
import { createApp } from './http/app';
import { SessionStore } from './sessions/store';
import { SettingsStore } from './settings/store';

async function main() {
  for (const dir of Object.values(config.paths)) if (!dir.endsWith('.json')) await mkdir(dir, { recursive: true });

  const settings = new SettingsStore();
  const content = new ContentStore();
  const vault = new BrainVault();
  await vault.init();
  const deps = {
    settings,
    content,
    sync: new ContentSync(settings, content),
    brain: new BrainService(content, vault, settings),
    sessions: new SessionStore(),
  };

  const app = createApp(deps);
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info('engine_listening', { url: `http://${config.host}:${info.port}`, data: config.paths.data });
  });
}

main().catch((error) => {
  log.error('engine_boot_failed', errorFields(error));
  process.exit(1);
});
