import { expect, test } from '@playwright/test';

/**
 * The maintenance surface end to end: sign in as a demo student, open the brain's
 * Maintenance tab, and exercise what is actually there — a seeded demo vault almost always
 * has orphans, but the spec asserts the honest states rather than a particular count.
 *
 * Unlike the onboarding specs this needs the developer stack (`pnpm dev`): the desktop app
 * on :5173 and the engine on :4100. When they are not up it skips with exactly that reason —
 * a red run on a box without the dev servers would be noise.
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

/** Demo personas sign in through the seeded panel; Ananya is the first-year account. */
const signInAsDemoStudent = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.goto(`${APP_URL}/`);
  await page.getByRole('button', { name: /exploring the demo/i }).click();
  await page.getByRole('button', { name: /first-year student/i }).click();
  await expect(page.getByText(/your brain/i).first()).toBeVisible({ timeout: 30_000 });
};

test.describe('wiki maintenance', () => {
  test('the maintenance tab lists findings with evidence and lets a suggestion be dismissed', async ({ page }) => {
    await needsDevStack();
    await signInAsDemoStudent(page);

    await page.goto(`${APP_URL}/#/brain`);
    await page.getByRole('tab', { name: /maintenance/i }).or(page.getByText(/^Maintenance/).first()).click();

    // The health panel is always there, whatever the findings are.
    await expect(page.getByText('Vault health')).toBeVisible();
    await expect(page.getByRole('button', { name: /run the (deep )?review/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /rebuild index/i })).toBeVisible();

    const findings = page.locator('text=/Orphan page|Missing source|Missing citation|Dead link|Unrecorded link|Not in the index|Course mapping|Oversized page|Schema issue|Changed outside the keeper/');
    const empty = page.getByText('Nothing needs attention');
    await expect(findings.first().or(empty)).toBeVisible({ timeout: 15_000 });

    if ((await findings.count()) > 0) {
      const before = await findings.count();
      // Dismissal is a decision, not a write: the finding leaves the list and the badge count drops.
      await page.getByRole('button', { name: /^dismiss$/i }).first().click();
      await expect(page.getByText(/dismissed/i).first()).toBeVisible();
      await expect(findings).toHaveCount(before - 1);
    }
  });

  test('an actionable finding can be filed and lands in the review dialog — nothing writes itself', async ({ page }) => {
    await needsDevStack();
    await signInAsDemoStudent(page);
    await page.goto(`${APP_URL}/#/brain`);
    await page.getByRole('tab', { name: /maintenance/i }).or(page.getByText(/^Maintenance/).first()).click();
    await expect(page.getByText('Vault health')).toBeVisible();

    const checkboxes = page.locator('input[type="checkbox"][aria-label^="Select repair"]');
    if ((await checkboxes.count()) === 0) {
      test.info().annotations.push({ type: 'note', description: 'No actionable findings in this vault — filing path not exercised.' });
      return;
    }
    await checkboxes.first().check();
    await page.getByRole('button', { name: /propose repairs/i }).click();

    // The same proposal review dialog the keeper proposals use opens — it decides, not us.
    await expect(page.getByText(/review the proposal/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /reject all/i }).click();
    await expect(page.getByText(/rejected — nothing was written|nothing was written/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
