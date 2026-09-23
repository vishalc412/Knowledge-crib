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

test('the empty inspector can be opened and closed without reserving unused graph space', async ({ page }) => {
  await page.goto(backend.url);
  const stage = page.locator('[data-kc-graph-stage]');
  const placeholder = page.getByLabel('Inspector placeholder');
  const toggle = page.locator('[data-kc-inspector-toggle]');

  await expect(stage).toBeVisible();
  await expect(placeholder).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const fullWidth = await stage.evaluate((element) => element.getBoundingClientRect().width);

  await toggle.click();
  await expect(placeholder).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => stage.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(fullWidth - 250);

  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(placeholder).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => stage.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(fullWidth - 3);

  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.click();
  await expect(placeholder).toBeVisible();
  await expect.poll(() => stage.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(300);
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(placeholder).toHaveCount(0);
});
