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

test('mobile starts in List and keeps Graph available without offering Split', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(backend.url);
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('list', { name: 'Graph results' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Graph', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.kc-stage-canvas')).toBeVisible();
});

test('Split keeps selection synchronized and restores its preference after a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(backend.url);
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Graph results' })).toBeVisible();
  await expect(page.locator('.kc-stage-canvas')).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByPlaceholder('Search code, docs, tables…').fill('normalizeInput');
  await page
    .getByRole('list', { name: 'Graph results' })
    .locator(`[data-kc-row-id="${backend.sym.id}"]`)
    .getByRole('button', { name: /^Inspect / })
    .click();
  await expect(page.locator('[data-kc-inspector]')).toContainText('normalizeInput');
  await expect(page.locator('[data-kc-explorer-scope]')).toContainText('Focus');
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('[data-kc-explorer-scope]')).toContainText('Focus');
  await expect(page.getByPlaceholder('Search code, docs, tables…')).toHaveValue('normalizeInput');
});

test('keyboard List journey reaches source and Blast, then returns to the same symbol result', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(backend.url);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const list = page.getByRole('list', { name: 'Graph results' });
  await expect(list).toBeVisible();
  const overview = await (await page.request.get(`${backend.url}/overview.json`)).json();
  const targetModule = overview.modules
    .filter((entry: { pathPrefix: string }) => 'src/index.ts'.startsWith(entry.pathPrefix))
    .sort(
      (a: { pathPrefix: string }, b: { pathPrefix: string }) =>
        b.pathPrefix.length - a.pathPrefix.length,
    )[0];
  const module = list.locator(`[data-kc-row-id="${targetModule.id}"]`);
  await module.getByRole('button', { name: /^Open / }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-kc-explorer-scope]')).toContainText('symbols');
  const symbol = list.locator(`[data-kc-row-id="${backend.sym.id}"]`);
  await symbol.getByRole('button', { name: /^Inspect / }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-kc-inspector-heading]')).toBeFocused();
  await page.locator('[data-kc-inspector-source]').getByRole('button', { name: 'Source' }).click();
  await expect(page.locator('[data-kc-inspector-source]')).toContainText('normalizeInput');
  await page.getByRole('button', { name: 'Blast radius' }).click();
  await expect(page.locator('[data-kc-explorer-scope]')).toContainText('Blast');
  await expect(page.getByRole('table', { name: 'Blast results' })).toBeVisible();
  await expect(page.locator('[data-kc-inspector]')).toContainText('discovered affected nodes');
  await expect(
    page.getByText('No reverse dependencies were discovered for this symbol.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to results' }).focus();
  await page.keyboard.press('Enter');
  await expect(symbol).toBeVisible();
  await expect(symbol.getByRole('button', { name: /^Inspect / })).toBeFocused();
});

test('zero graph matches expose scope and Clear search', async ({ page }) => {
  await page.goto(backend.url);
  await page.getByPlaceholder('Search code, docs, tables…').fill('no-such-symbol-2026');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByText('No matches in the code graph')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByRole('list', { name: 'Graph results' })).toBeVisible();
});

test('node-type filters change List totals and survive presentation switches', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(backend.url);
  await page.getByPlaceholder('Search code, docs, tables…').fill('normalizeInput');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const summary = page.locator('.kc-result-summary');
  const before = Number((await summary.textContent())?.match(/^\d+/)?.[0]);
  expect(before).toBeGreaterThan(0);
  await page
    .locator('[data-kc-navigation-rail]')
    .getByRole('button', { name: /Function/ })
    .click();
  const filtered = Number((await summary.textContent())?.match(/^\d+/)?.[0]);
  expect(filtered).toBeLessThan(before);
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  expect(Number((await summary.textContent())?.match(/^\d+/)?.[0])).toBe(filtered);
  await expect(page.getByPlaceholder('Search code, docs, tables…')).toHaveValue('normalizeInput');
  await page.locator('[data-kc-navigation-rail]').getByRole('button', { name: 'Reset' }).click();
  expect(Number((await summary.textContent())?.match(/^\d+/)?.[0])).toBe(before);
});

test('a failed graph fetch has a Retry that restores real results', async ({ page }) => {
  await page.route('**/graph.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto(backend.url);
  await expect(page.getByText('Graph could not load', { exact: true })).toBeVisible();
  await page.unroute('**/graph.json');
  await page.getByRole('button', { name: 'Retry graph' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Graph results' })).toBeVisible();
  await expect(page.locator('[data-kc-result-row]').first()).toBeVisible();
});
