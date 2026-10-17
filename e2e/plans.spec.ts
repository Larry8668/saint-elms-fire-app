import { expect, test } from '@playwright/test';

/**
 * Study plans on the developer stack (`pnpm dev`): stating a goal either yields a proposal the
 * student previews before anything is tracked, or — with no planning model reachable — an
 * honest inline error. Both are correct outcomes; a silent failure is not. Skips when the stack is down.
 */

const APP_URL = process.env.E2E_APP_URL ?? 'http://127.0.0.1:5173';
const ENGINE_URL = process.env.E2E_ENGINE_URL ?? 'http://127.0.0.1:4100';
const GOAL = 'Revise thermodynamics before Thursday';

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

test.describe('study plans', () => {
  test('a goal becomes a previewed proposal (or an honest error), and a proposal can be discarded', async ({ page }) => {
    test.setTimeout(300_000);
    await needsDevStack();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${APP_URL}/`);
    await page.getByRole('button', { name: /exploring the demo/i }).click();
    await page.getByRole('button', { name: /first-year student/i }).click();
    await expect(page.getByText(/your brain/i).first()).toBeVisible({ timeout: 30_000 });

    const card = page.getByRole('region', { name: 'Study plans' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole('button', { name: 'New plan' }).click();
    await card.getByLabel('Plan goal').fill(GOAL);
    await card.getByRole('button', { name: 'Propose' }).click();

    const proposal = card.getByLabel(`Proposed plan: ${GOAL}`);
    const error = card.getByRole('alert');
    await expect(proposal.or(error)).toBeVisible({ timeout: 240_000 });

    if (await error.isVisible()) {
      await expect(error).toHaveText(/not reachable|None of the proposed steps|waiting for a decision/);
      return;
    }
    // Every listed step names what it points at before the student approves anything.
    await expect(proposal.getByRole('listitem').first()).toContainText(/Page|Lesson|Signal/);
    await proposal.getByRole('button', { name: 'Discard' }).click();
    await expect(proposal).toBeHidden();
  });
});
