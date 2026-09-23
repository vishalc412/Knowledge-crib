import { expect, test } from '@playwright/test';
import { MemoryBackend } from './backend.js';

let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend();
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

test('Memory home explains published index and reader snapshot separately', async ({ page }) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  const published = page.locator('[data-kc-health="published"]');
  const reader = page.locator('[data-kc-health="reader"]');
  await expect(published).toContainText('Published index');
  await expect(reader).toContainText('Reader snapshot');
  await expect(published).toContainText('Checked revision');
  await expect(reader).toContainText('Checked revision');
  await expect(published).toContainText('Last successful');
  await expect(reader).toContainText('Last successful');
  await expect(page.locator('[data-kc-health="retrieval"]')).toContainText('Search uses');
  await expect(page.locator('[data-kc-health="sync"]')).toContainText('local');
  const tileLabel = page.locator('[data-kc-memory-home-label]').first();
  expect(
    await tileLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(12);
});

test('Memory list favors a compact claim preview and keeps full detail available', async ({
  page,
}) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await page.locator('[data-kc-memory-home-action="history"]').click();
  const row = page.locator('[data-kc-mem-row]').first();
  await expect(row).toBeVisible();
  await expect(row.locator('[data-kc-memory-preview]')).toBeVisible();
  await expect(row.locator('[data-kc-memory-next-action]')).toHaveText('Inspect claim');
  const clamp = await row
    .locator('[data-kc-memory-preview]')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-line-clamp'));
  expect(clamp).toBe('1');
  await row.click();
  await expect(page.locator('[data-kc-mem-detail-back]')).toBeVisible();
  await expect(page.locator('[data-kc-memory-detail-claim]')).toContainText('normalizeInput');
  await expect(page.locator('[data-kc-memory-technical]')).toBeVisible();
});

test('a failed Memory load states the action and can retry without leaving the panel', async ({
  page,
}) => {
  let failOnce = true;
  // Phase 2 requests carry a query (view, offset, limit), so match it as well.
  await page.route('**/memory.json?*', async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, body: 'ledger temporarily unavailable' });
    } else {
      await route.continue();
    }
  });
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await expect(page.getByRole('alert')).toContainText('Could not load Memory');
  await page.getByRole('button', { name: 'Retry Memory' }).click();
  await page.locator('[data-kc-memory-home-action="history"]').click();
  await expect(page.locator('[data-kc-mem-row]').first()).toBeVisible();
});

test('a failed pending queue explains the failure and retries the same page', async ({ page }) => {
  let failOnce = true;
  await page.route('**/memory/pending.json?*', async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, body: 'queue temporarily unavailable' });
    } else {
      await route.continue();
    }
  });
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await page.getByTitle('Review pending outcomes').click();
  await expect(page.locator('[data-kc-pending-error]')).toContainText('Could not load Pending');
  await page.getByRole('button', { name: 'Retry Pending' }).click();
  await expect(page.getByText('ready 1')).toBeVisible();
});

test('a failed record detail can retry without losing the originating row', async ({ page }) => {
  let failOnce = true;
  await page.route('**/memory/record.json?*', async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, body: 'record temporarily unavailable' });
    } else {
      await route.continue();
    }
  });
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await page.locator('[data-kc-memory-home-action="history"]').click();
  const row = page.locator('[data-kc-mem-row]').first();
  await expect(row).toBeVisible();
  const recordId = await row.getAttribute('data-kc-mem-row');
  await row.click();
  await expect(page.locator('[data-kc-detail-error]')).toContainText('Could not load claim');
  await page.getByRole('button', { name: 'Retry claim' }).click();
  await expect(page.locator('[data-kc-memory-detail-claim]')).toBeVisible();
  await page.locator('[data-kc-mem-detail-back]').click();
  await expect(page.locator(`[data-kc-mem-row="${recordId}"]`)).toBeVisible();
});
