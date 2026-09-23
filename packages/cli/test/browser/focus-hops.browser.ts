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

test('Focus reveals real architectural context through four hops and can reset', async ({
  page,
}) => {
  await page.setViewportSize({ width: 997, height: 964 });
  const names = ['RootAnchor', 'First', 'Sibling', 'Second', 'Third', 'Fourth'];
  const nodes = names.map((id, i) => ({
    id,
    label: id,
    kind: 'function',
    importance: names.length - i,
    tier: 'primary',
  }));
  const edges = [
    { src: 'RootAnchor', dst: 'First', rel: 'calls' },
    { src: 'RootAnchor', dst: 'Sibling', rel: 'calls' },
    { src: 'First', dst: 'Sibling', rel: 'calls' },
    { src: 'First', dst: 'Second', rel: 'calls' },
    { src: 'Second', dst: 'Third', rel: 'calls' },
    { src: 'Third', dst: 'Fourth', rel: 'calls' },
  ];
  await page.route('**/graph.json', (route) =>
    route.fulfill({
      json: {
        nodes,
        edges,
        clusters: [],
        stats: { nodes: nodes.length, edges: edges.length, clusters: 0 },
      },
    }),
  );
  await page.route('**/overview.json', (route) => route.fulfill({ json: { modules: [] } }));
  await page.goto(backend.url);

  await page.getByPlaceholder('Search code, docs, tables…').fill('RootAnchor');
  await expect(page.getByText('1 match · 2 related')).toBeVisible();
  const stage = page.locator('[data-kc-graph-stage]');
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  const zoom =
    Number(
      (await page.locator('[data-kc-stage-zoom] button').nth(1).innerText()).replace('%', ''),
    ) / 100;
  // Search centres its one exact match at world (0, 0); graphFit offsets the camera 20 world
  // units vertically to leave room for labels, so click the node rather than the stage midpoint.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2 - 20 * zoom);

  await expect(page.getByRole('button', { name: /Direct neighbors 2/ })).toBeVisible();
  await page.getByRole('button', { name: /Expand to 2-hop context 1/ }).click();
  await expect(page.getByRole('button', { name: /2-hop context 1 .*1 shown/ })).toBeVisible();
  await page.getByRole('button', { name: /Expand to 3-hop context 1/ }).click();
  await expect(page.getByRole('button', { name: /3-hop context 1 .*1 shown/ })).toBeVisible();
  await page.getByRole('button', { name: /Expand to 4-hop context 1/ }).click();
  await expect(page.getByRole('button', { name: /4-hop context 1 .*1 shown/ })).toBeVisible();
  await page.getByRole('button', { name: /Return to 1 hop/ }).click();
  await expect(page.getByRole('button', { name: /Expand to 2-hop context 1/ })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: /Expand to 2-hop context 1/ }).click();
  await expect(page.getByRole('button', { name: /Expand to 3-hop context 1/ })).toBeVisible();
});

test('Focus does not offer an empty hop behind a capped parent ring', async ({ page }) => {
  await page.setViewportSize({ width: 997, height: 964 });
  const direct = Array.from({ length: 61 }, (_, i) => `direct-${i}`);
  const nodes = [
    { id: 'RootAnchor', label: 'RootAnchor', kind: 'function', importance: 1000 },
    ...direct.map((id, i) => ({ id, label: id, kind: 'function', importance: 100 - i })),
    { id: 'Outer', label: 'Outer', kind: 'function', importance: 1 },
  ];
  const edges = [
    ...direct.map((id) => ({ src: 'RootAnchor', dst: id, rel: 'calls' })),
    { src: direct[60], dst: 'Outer', rel: 'calls' },
  ];
  await page.route('**/graph.json', (route) =>
    route.fulfill({
      json: {
        nodes,
        edges,
        clusters: [],
        stats: { nodes: nodes.length, edges: edges.length, clusters: 0 },
      },
    }),
  );
  await page.route('**/overview.json', (route) => route.fulfill({ json: { modules: [] } }));
  await page.goto(backend.url);

  await page.getByPlaceholder('Search code, docs, tables…').fill('RootAnchor');
  await expect(page.getByText(/1 match · \d+ related/)).toBeVisible();
  const stage = page.locator('[data-kc-graph-stage]');
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  const zoom =
    Number(
      (await page.locator('[data-kc-stage-zoom] button').nth(1).innerText()).replace('%', ''),
    ) / 100;
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2 - 20 * zoom);

  await expect(page.getByRole('button', { name: /Direct neighbors 61 .*60 shown/ })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /2-hop context beyond shown branches/ }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: /Expand to 2-hop context/ })).toHaveCount(0);
});
