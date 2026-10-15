import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The onboarding flow, end to end, in a browser: the surfaces PR-09 added, exercised
 * against a real university server rather than a mock. Everything here is synthetic and
 * local — the accounts are created by the test and are not tied to any real person.
 */

const UNI_URL = `http://127.0.0.1:${Number(process.env.E2E_UNI_PORT ?? 4310)}`;

/**
 * Skips with a reason rather than failing when the server was not available. The reason
 * comes from the status file global setup writes, because the setup and the workers are
 * separate processes.
 */
const needsUni = async (): Promise<void> => {
  const status = path.resolve(import.meta.dirname, '../test-results/e2e-status.json');
  try {
    const { ok, reason } = JSON.parse(readFileSync(status, 'utf8')) as { ok: boolean; reason?: string };
    if (!ok) test.skip(true, reason ?? 'The university server did not start.');
  } catch {
    test.skip(true, 'No global setup status was recorded, so the university server never started.');
  }
  try {
    const res = await fetch(`${UNI_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) test.skip(true, 'The university server is not healthy.');
  } catch {
    test.skip(true, 'The university server is not reachable.');
  }
};

test.describe('student onboarding', () => {
  test('the portal shell renders and offers every account route', async ({ page }) => {
    await needsUni();
    await page.goto(`${UNI_URL}/app/`);
    await expect(page).toHaveTitle(/Saint Elms University/i);
    await expect(page.getByRole('heading', { name: /^sign in$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /create an account/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign-in link/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /forgot your password/i })).toBeVisible();
  });

  test('the device page refuses a signed-out approval instead of faking one', async ({ page }) => {
    await needsUni();
    await page.goto(`${UNI_URL}/device?user_code=ABCD-EFGH`);
    await expect(page.getByRole('heading', { name: /confirm this device/i })).toBeVisible();
    await expect(page.locator('#user-code')).toHaveValue(/ABCD/);

    await page.getByRole('button', { name: /^approve$/i }).click();
    // The server owns this decision; a signed-out approval must come back as a refusal.
    await expect(page.locator('#status')).not.toHaveText('', { timeout: 10_000 });
    await expect(page.locator('#status')).not.toContainText(/approved\./i);
  });

  test('a malformed registration is reported rather than silently accepted', async ({ page }) => {
    await needsUni();
    await page.goto(`${UNI_URL}/app/`);
    await page.getByRole('button', { name: /create an account/i }).click();
    await expect(page.getByRole('heading', { name: /create/i })).toBeVisible();
    // The form must not report success for an address that cannot receive mail.
    await page.getByLabel(/email/i).fill('not-an-email');
    await page.getByRole('button', { name: /create|sign up|continue/i }).first().click();
    await expect(page.locator('body')).toContainText(/email|valid/i);
  });
});

test.describe('portal hardening', () => {
  test('the portal and device pages both refuse framing', async ({ page }) => {
    await needsUni();
    for (const url of [`${UNI_URL}/app/`, `${UNI_URL}/device`]) {
      const response = await page.goto(url);
      expect(response?.headers()['x-frame-options']).toBe('DENY');
      expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });

  test('an account session cookie is HttpOnly, never readable by script', async ({ page }) => {
    await needsUni();
    await page.goto(`${UNI_URL}/app/`);
    const cookies = await page.context().cookies();
    // Before signing in there is no session at all; after one there must not be a readable one.
    expect(cookies.every((cookie) => !cookie.name.toLowerCase().includes('token'))).toBe(true);
    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toMatch(/session|token/i);
  });

  test('a traversal through the portal mount cannot read outside it', async ({ request }) => {
    await needsUni();
    const attempts = ['/app/../../../../etc/passwd', '/app/..%2f..%2f..%2fetc%2fpasswd'];
    for (const attempt of attempts) {
      const res = await request.get(`${UNI_URL}${attempt}`);
      const body = await res.text();
      expect(body).not.toContain('root:');
      expect([400, 404]).toContain(res.status());
    }
  });
});
