import { expect, test } from '@playwright/test';

/**
 * The suggestion rail end to end on the developer stack (`pnpm dev`): a demo student's
 * teachers each offer ready-to-click questions with inspectable provenance, and a click
 * becomes the student's own message. Skips with the reason when the stack is not up.
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

test.describe('suggested questions', () => {
  test('each teacher offers its own chips; a click is sent as the student’s message', async ({ page }) => {
    await needsDevStack();
    await page.goto(`${APP_URL}/`);
    await page.getByRole('button', { name: /exploring the demo/i }).click();
    await page.getByRole('button', { name: /first-year student/i }).click();
    await expect(page.getByText(/your brain/i).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Teachers' }).click();
    const rail = page.getByRole('list', { name: 'Suggested questions' });
    await expect(rail).toBeVisible({ timeout: 20_000 });
    const guideChips = await rail.getByRole('button').allTextContents();
    expect(guideChips.length).toBeGreaterThan(0);
    expect(guideChips.length).toBeLessThanOrEqual(5);

    await rail.getByRole('button').first().hover();
    await expect(page.getByText(/^Because:/).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/suggestion-rail-guide.png' });

    // The Friend's bank is scoped differently from the Guide's.
    await page.getByRole('tab', { name: /friend/i }).click();
    await expect(page.getByRole('list', { name: 'Suggested questions' }).or(page.getByRole('textbox')).first()).toBeVisible();
    const friendChips = await page.getByRole('list', { name: 'Suggested questions' }).getByRole('button').allTextContents();
    for (const chip of friendChips) expect(guideChips).not.toContain(chip);

    await page.getByRole('tab', { name: /guide/i }).click();
    const first = guideChips[0]!;
    await page.getByRole('list', { name: 'Suggested questions' }).getByRole('button', { name: first }).click();
    await expect(page.getByRole('log').getByText(first, { exact: true })).toBeVisible({ timeout: 10_000 });
  });
});
