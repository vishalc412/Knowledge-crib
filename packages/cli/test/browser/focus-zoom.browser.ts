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

test('Focus fits a repo-scale graph and keeps its compact zoom usable', async ({ page }) => {
  await page.setViewportSize({ width: 997, height: 964 });
  const clusters = Array.from({ length: 9 }, (_, i) => ({
    id: `cluster-${i}`,
    label: `Module ${i + 1}`,
    color: '#5b8cff',
  }));
  const nodes = Array.from({ length: 1_809 }, (_, i) => ({
    id: `symbol-${i}`,
    kind: i < 9 ? 'class' : 'file',
    clusterId: `cluster-${i % clusters.length}`,
    label: `Signal ${i}`,
    importance: 1_809 - i,
    tier: i < 90 ? 'primary' : 'detail',
  }));
  await page.route('**/graph.json', (route) =>
    route.fulfill({
      json: {
        nodes,
        edges: [],
        clusters,
        stats: { nodes: nodes.length, edges: 0, clusters: clusters.length },
      },
    }),
  );
  await page.route('**/overview.json', (route) => route.fulfill({ json: { modules: [] } }));
  await page.goto(backend.url);

  await expect(page.locator('[data-kc-command="focus"]')).toBeVisible();
  const zoom = page.locator('[data-kc-stage-zoom]');
  const fit = zoom.locator('button').nth(1);
  await expect
    .poll(async () => Number((await fit.innerText()).replace('%', '')))
    .toBeGreaterThan(20);
  const fittedZoom = Number((await fit.innerText()).replace('%', ''));
  expect(fittedZoom).toBeGreaterThan(0);

  await page.locator('[data-kc-inspector-toggle]').click();
  await expect
    .poll(async () => Number((await fit.innerText()).replace('%', '')))
    .toBeLessThan(fittedZoom);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect
    .poll(async () => Number((await fit.innerText()).replace('%', '')))
    .toBeGreaterThanOrEqual(fittedZoom * 0.9);

  const restoredZoom = Number((await fit.innerText()).replace('%', ''));
  await zoom.locator('button').nth(2).click();
  await expect
    .poll(async () => Number((await fit.innerText()).replace('%', '')))
    .toBeGreaterThan(restoredZoom);
  await fit.click();
  await expect
    .poll(async () => Number((await fit.innerText()).replace('%', '')))
    .toBeGreaterThan(20);
  for (let i = 0; i < 24; i++) await zoom.locator('button').nth(0).click();
  await expect(fit).toHaveText('20%');
  await fit.click();
  await expect
    .poll(async () => Number((await fit.innerText()).replace('%', '')))
    .toBeGreaterThan(20);
});
