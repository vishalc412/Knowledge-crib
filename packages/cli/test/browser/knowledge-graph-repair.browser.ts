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

test('Overview renders before full graph is requested and stays selected', async ({ page }) => {
  let graphRequests = 0;
  await page.route('**/graph.json', (route) => {
    graphRequests++;
    return route.continue();
  });
  await page.goto(backend.url);
  await expect(page.locator('[data-kc-command="overview"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.kc-rail-item').first()).toBeVisible();
  expect(graphRequests).toBe(0);
  await page.locator('[data-kc-command="focus"]').click();
  await expect.poll(() => graphRequests).toBe(1);
  await expect(page.locator('[data-kc-command="focus"]')).toHaveAttribute('aria-pressed', 'true');
});

test('opening a module renders its cards from the module projection, not the full graph', async ({
  page,
}) => {
  let moduleRequests = 0;
  // The full graph never arrives: the module's cards must not depend on it.
  await page.route('**/graph.json', () => new Promise<void>(() => {}));
  await page.route('**/overview/module.json**', (route) => {
    moduleRequests++;
    return route.continue();
  });
  await page.goto(backend.url);
  const moduleRow = page.locator('.kc-rail-item').first();
  await expect(moduleRow).toBeVisible();
  const moduleName = (await moduleRow.innerText()).split('\n')[0]!.trim();
  await moduleRow.click();
  await expect.poll(() => moduleRequests).toBe(1);
  await expect(page.locator('[data-kc-command="overview"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The stage breadcrumb names the opened module while /graph.json is still pending.
  await expect(page.locator('[data-kc-stage-breadcrumbs]')).toContainText(moduleName);
});

test('narrow header aligns search and keeps Memory named', async ({ page }) => {
  await page.setViewportSize({ width: 726, height: 863 });
  await page.goto(backend.url);
  const input = page.getByRole('textbox', { name: 'Search graph' });
  await expect(input).toBeVisible();
  await expect(page.locator('.kc-memory-label')).toBeVisible();
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('.kc-topbar')!.getBoundingClientRect();
    const search = document.querySelector('#kc-graph-search')!.getBoundingClientRect();
    const label = document.querySelector('label[for="kc-graph-search"]')!.getBoundingClientRect();
    const memory = document.querySelector('[data-kc-memory-trigger]')!.getBoundingClientRect();
    return {
      headerBottom: header.bottom,
      searchTop: search.top,
      searchBottom: search.bottom,
      searchRight: search.right,
      labelWidth: label.width,
      memoryRight: memory.right,
    };
  });
  expect(geometry.labelWidth).toBeLessThanOrEqual(1);
  expect(geometry.searchTop).toBeGreaterThanOrEqual(0);
  expect(geometry.searchBottom).toBeLessThanOrEqual(geometry.headerBottom);
  expect(geometry.searchRight).toBeLessThanOrEqual(726);
  expect(geometry.memoryRight).toBeLessThanOrEqual(726);
});

test('closed work stays visible in Work history and opens read-only', async ({ page }) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await page.locator('[data-kc-memory-home-action="resume"]').click();
  await page.locator(`[data-kc-mem-choice="${backend.intakeId}"]`).click();
  await expect(page.locator('[data-kc-mem-intake-done]')).toBeVisible();
  await page.locator('[data-kc-mem-intake-done]').click();
  await expect(page.locator('[data-kc-mem-work-summary]')).toContainText('closed 1');
  await page.locator(`[data-kc-mem-choice="${backend.intakeId}"]`).click();
  await expect(page.locator('[data-kc-mem-intake-back]')).toBeVisible();
  await expect(page.locator('[data-kc-mem-resume-btn]')).toHaveCount(0);
  await expect(page.locator('[data-kc-mem-intake-done]')).toHaveCount(0);
});
