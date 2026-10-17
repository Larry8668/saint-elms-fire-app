import { expect, test } from '@playwright/test';

/**
 * Teacher metrics on the developer stack (`pnpm dev`): Settings shows local-only counters with
 * their counts, never a bare percentage on a tiny sample. Skips when the stack is down.
 */

const APP_URL = process.env.E2E_APP_URL ?? 'http://127.0.0.1:5173';
const ENGINE_URL = process.env.E2E_ENGINE_URL ?? 'http://127.0.0.1:4100';

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

test.describe('teacher metrics', () => {
  test('settings shows the local counters and can refresh them', async ({ page }) => {
    test.setTimeout(120_000);
    await needsDevStack();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${APP_URL}/`);
    await page.getByRole('button', { name: /exploring the demo/i }).click();
    await page.getByRole('button', { name: /first-year student/i }).click();
    await expect(page.getByText(/your brain/i).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Settings' }).click();
    const card = page.getByRole('region', { name: 'How your teachers are doing' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('never sent anywhere');

    for (const label of ['Suggestions you used', 'Nudges you opened', 'False alerts', 'Plans finished', 'Wiki edits accepted', 'Refused turns']) {
      await expect(card.getByText(label)).toBeVisible();
    }
    // Every tile states its sample: no data, a small count, or counts with a percentage.
    await expect(card.getByText(/No data yet|of \d+/).first()).toBeVisible();

    const reload = page.waitForResponse((res) => res.url().includes('/api/metrics') && res.request().method() === 'GET');
    await card.getByRole('button', { name: 'Refresh teacher metrics' }).click();
    expect((await reload).status()).toBe(200);
  });

  test('suggestion chips the student sees are counted, and show up in settings', async ({ page }) => {
    test.setTimeout(120_000);
    await needsDevStack();
    await page.goto(`${APP_URL}/`);
    await page.getByRole('button', { name: /exploring the demo/i }).click();
    await page.getByRole('button', { name: /first-year student/i }).click();
    await expect(page.getByText(/your brain/i).first()).toBeVisible({ timeout: 30_000 });

    const recorded = page.waitForResponse((res) => res.url().endsWith('/api/metrics/events') && res.request().method() === 'POST', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Teachers' }).click();
    await expect(page.getByRole('list', { name: 'Suggested questions' })).toBeVisible({ timeout: 20_000 });
    const response = await recorded;
    expect(response.status()).toBe(202);
    const sent = response.request().postDataJSON() as { events: Array<{ kind: string }> };
    expect(sent.events.some((e) => e.kind === 'suggestion_shown')).toBe(true);

    await page.getByRole('button', { name: 'Settings' }).click();
    const card = page.getByRole('region', { name: 'How your teachers are doing' });
    await expect(card.getByText('Suggestions you used').locator('..')).toContainText(/of [1-9]\d*/, { timeout: 15_000 });
  });
});
