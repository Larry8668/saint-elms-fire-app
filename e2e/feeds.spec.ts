import { expect, test } from '@playwright/test';

/**
 * Subject feeds on the developer stack (`pnpm dev`): a student-added feed is listed as not
 * fetched until the consent switch, and removing it clears it. The address is a reserved
 * `.invalid` host, so nothing real is ever contacted. Skips with the reason when the stack is down.
 */

const APP_URL = process.env.E2E_APP_URL ?? 'http://127.0.0.1:5173';
const ENGINE_URL = process.env.E2E_ENGINE_URL ?? 'http://127.0.0.1:4100';
const FEED = 'https://news.example.invalid/rss.xml';

const needsDevStack = async (): Promise<void> => {
  for (const [url, name] of [
    [`${ENGINE_URL}/api/health`, 'the engine'],
    [APP_URL, 'the desktop dev server'],
  ] as const) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) test.skip(true, `${name} answered ${res.status} at ${url}.`);
    } catch {
      test.skip(true, `${name} is not reachable at ${url} — start it with "pnpm dev".`);
    }
  }
};

test.describe('subject feeds', () => {
  test('a student feed waits for consent, can be switched on, and is removed cleanly', async ({ page }) => {
    await needsDevStack();
    await page.goto(`${APP_URL}/`);
    await page.getByRole('button', { name: /exploring the demo/i }).click();
    await page.getByRole('button', { name: /first-year student/i }).click();
    await expect(page.getByText(/your brain/i).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Subject feeds')).toBeVisible();
    await page.getByLabel('Feed address').fill(FEED);
    await page.getByRole('button', { name: 'Add feed' }).click();

    const row = page.getByRole('list', { name: 'Feeds' }).getByRole('listitem').filter({ hasText: 'news.example.invalid' });
    await expect(row).toContainText('Not fetched');
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/feeds-panel.png' });

    await row.getByRole('switch', { name: /allow fetching/i }).click();
    await expect(row).not.toContainText('Not fetched');

    await row.getByRole('button', { name: /remove/i }).click();
    await expect(row).toHaveCount(0);
  });
});
