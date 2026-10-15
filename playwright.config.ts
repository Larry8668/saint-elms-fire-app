import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the real uni, which serves `/app` and `/device` itself and is
 * therefore the same origin as the account endpoints — that is what the HttpOnly session
 * cookie needs. Nothing here talks to a mock: the thing under test is the wiring.
 *
 * The uni is started by `globalSetup` against a disposable PostgreSQL, on ports chosen to
 * avoid the developer's own `pnpm dev`.
 */

const UNI_PORT = Number(process.env.E2E_UNI_PORT ?? 4310);
const PORTAL_DIR = process.env.E2E_PORTAL_DIR ?? 'apps/desktop/dist-portal';

export const uniUrl = `http://127.0.0.1:${UNI_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // The onboarding flow is sequential by nature: register, verify, apply.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  // A spec that needs the university server is blocked rather than failing on a dev box
  // where it was never started.
  use: {
    baseURL: uniUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  timeout: 90_000,
  expect: { timeout: 10_000 },
});

export { UNI_PORT, PORTAL_DIR };
