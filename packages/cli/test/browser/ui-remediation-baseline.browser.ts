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

for (const width of [320, 375]) {
  test(`mobile navigation opens its module and type controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(backend.url);
    const rail = page.locator('[data-kc-navigation-rail]');
    await rail.locator('[data-kc-rail-toggle]').click();
    await expect(rail.locator('.kc-rail-body')).toBeVisible();
    await expect(rail.getByText('Modules', { exact: true })).toBeVisible();
    await expect(rail.getByText('Node types', { exact: true })).toBeVisible();
  });
}

test('light theme stage controls have readable text contrast', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(backend.url);
  await expect(page.locator('[data-kc-shell]')).toHaveAttribute('data-kc-theme', 'light');
  const ratio = await page.locator('[data-kc-stage-breadcrumbs]').evaluate((element) => {
    const channels = (value: string) =>
      [...value.matchAll(/[\d.]+/g)].map((match) => Number(match[0]));
    const [red, green, blue, alpha = 1] = channels(getComputedStyle(element).backgroundColor);
    const [baseRed, baseGreen, baseBlue] = channels(
      getComputedStyle(document.querySelector('[data-kc-shell]')!).backgroundColor,
    );
    const surface = [red, green, blue].map(
      (part, index) => part * alpha + [baseRed, baseGreen, baseBlue][index] * (1 - alpha),
    );
    const foreground = channels(getComputedStyle(element).color).slice(0, 3);
    const luminance = (rgb: number[]) =>
      rgb
        .map((part) => part / 255)
        .map((part) => (part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4))
        .reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
    const values = [luminance(surface), luminance(foreground)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('Active and Needs review cards open matching destinations', async ({ page }) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await page.getByTitle('Open the claims agents can recall now').click();
  await expect(page.getByRole('heading', { name: 'Active', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Memory home' }).click();
  await page.getByTitle('Open the claims that need review, with the reason for each').click();
  await expect(page.getByRole('heading', { name: 'Needs review', exact: true })).toBeVisible();
});

test('a keyboard user can enter the textual symbol explorer', async ({ page }) => {
  await page.goto(backend.url);
  const list = page.getByRole('button', { name: 'List', exact: true });
  await list.focus({ timeout: 5_000 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Graph results' })).toBeVisible();
});

test('the document declares its language and descriptive title', async ({ page }) => {
  await page.goto(backend.url);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle(/Knowledge-Crib/);
});

test('zero graph-search results offer an explicit recovery action', async ({ page }) => {
  await page.goto(backend.url);
  await page.getByPlaceholder('Search code, docs, tables…').fill('no-such-symbol-2026');
  await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
});
