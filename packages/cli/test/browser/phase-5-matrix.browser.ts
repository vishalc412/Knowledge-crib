import { type Page, expect, test } from '@playwright/test';
import { LONG_CLAIM, MemoryBackend } from './backend.js';
import { sampleTextContrast, undersizedTargets } from './contrast.js';

// The Phase 5 test matrix the plan requires and the first Phase 5 PR did not carry: both themes at
// 320/375/768/1280/1440 px, long and multilingual content, 200% zoom, contrast in normal, hover,
// selected and error states, and the stale/partial/failure fixtures of the async-state audit.
// Also the Phase 3 loading and empty-index states.
let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend({ longContent: true });
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

const WIDTHS = [320, 375, 768, 1280, 1440];

/** Sample only settled pixels: entry animations fade opacity, which would under-read contrast. */
async function settled(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
}

async function noHorizontalOverflow(page: Page, width: number) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

async function routeSmallGraph(page: Page) {
  const nodes = ['RootAnchor', 'Helper'].map((id, i) => ({
    id,
    label: id,
    kind: 'function',
    importance: 2 - i,
    qualified: `demo.${id}`,
    file: 'src/index.ts',
    span: { start: 2, end: 4 },
  }));
  await page.route('**/graph.json', (route) =>
    route.fulfill({
      json: {
        nodes,
        edges: [{ src: 'RootAnchor', dst: 'Helper', rel: 'calls' }],
        clusters: [],
        stats: { nodes: 2, edges: 1, clusters: 0 },
      },
    }),
  );
  await page.route('**/overview.json', (route) => route.fulfill({ json: { modules: [] } }));
}

/** Open a symbol's inspector through the List presentation (no canvas coordinates). */
async function inspectThroughList(page: Page) {
  await page.locator('[data-kc-presentation="list"]').click();
  await page.getByPlaceholder('Search code, docs, tables…').fill('RootAnchor');
  await page.locator('[data-kc-result-row] button').first().click();
  await expect(page.locator('[data-kc-inspector-heading]')).toBeVisible();
}

for (const scheme of ['dark', 'light'] as const) {
  for (const width of WIDTHS) {
    test(`${scheme} at ${width}px: reflows, reads and targets hold on the shell and Memory`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(backend.url);
      await expect(page.locator('[data-kc-shell]')).toHaveAttribute('data-kc-theme', scheme);
      const minimum = width <= 760 ? 44 : 24;
      await noHorizontalOverflow(page, width);
      await settled(page);
      expect(await sampleTextContrast(page, '[data-kc-shell]')).toEqual([]);
      expect(await undersizedTargets(page, '[data-kc-shell]', minimum)).toEqual([]);
      await page.locator('[data-kc-memory-trigger]').click();
      await expect(page.locator('[data-kc-memory-home-action="history"]')).toBeVisible({
        timeout: 20_000,
      });
      await noHorizontalOverflow(page, width);
      await settled(page);
      expect(await sampleTextContrast(page, '[data-kc-memory-panel]')).toEqual([]);
      expect(await undersizedTargets(page, '[data-kc-memory-panel]', minimum)).toEqual([]);
    });
  }

  test(`${scheme}: hover, selected, focus and error states keep readable text`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(backend.url);
    // hover: a rail row and a List result action
    await page.locator('.kc-rail-item').first().hover();
    await settled(page);
    expect(await sampleTextContrast(page, '[data-kc-navigation-rail]')).toEqual([]);
    await page.locator('[data-kc-presentation="split"]').click();
    await page.locator('[data-kc-result-row] button').first().hover();
    await settled(page);
    expect(await sampleTextContrast(page, '.kc-result-panel')).toEqual([]);
    // selected: the pressed presentation and view segments
    await expect(page.locator('[data-kc-presentation="split"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await settled(page);
    expect(await sampleTextContrast(page, '.kc-topbar')).toEqual([]);
    // focus: keyboard focus on a result action
    await page.locator('[data-kc-result-row] button').first().focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await settled(page);
    expect(await sampleTextContrast(page, '.kc-result-panel')).toEqual([]);
    // selected tab inside History, then hover a ledger row
    await page.locator('[data-kc-memory-trigger]').click();
    await page.locator('[data-kc-memory-home-action="history"]').click();
    await page.getByRole('group', { name: 'Lifecycle group' }).getByRole('button').nth(1).click();
    await page.getByRole('group', { name: 'Lifecycle group' }).getByRole('button').first().click();
    await page.locator('[data-kc-mem-row]').first().hover();
    await settled(page);
    expect(await sampleTextContrast(page, '[data-kc-memory-panel]')).toEqual([]);
    // error: a failed Memory load and its recovery control
    await page.route('**/memory.json?*', (route) => route.fulfill({ status: 503, body: 'down' }));
    await page.getByRole('button', { name: 'Back to Memory home' }).click();
    await expect(page.getByRole('button', { name: 'Retry Memory' })).toBeVisible();
    await settled(page);
    expect(await sampleTextContrast(page, '[data-kc-memory-panel]')).toEqual([]);
  });
}

test('long multilingual claims preview on one line and wrap in full on detail at 375px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await page.locator('[data-kc-memory-home-action="history"]').click();
  const row = page.locator(`[data-kc-mem-row="${backend.longRecordId}"]`);
  await expect(row).toBeVisible();
  const preview = row.locator('[data-kc-memory-preview]');
  const lines = await preview.evaluate(
    (el) => el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
  );
  expect(lines).toBeLessThanOrEqual(1.05);
  await noHorizontalOverflow(page, 375);
  await row.click();
  const claim = page.locator('[data-kc-mem-claim]');
  await expect(claim).toHaveText(LONG_CLAIM);
  expect(await claim.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await noHorizontalOverflow(page, 375);
});

test('at 200% zoom (640 × 450 CSS px) the shell and List reflow without horizontal scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto(backend.url);
  await noHorizontalOverflow(page, 640);
  await page.locator('[data-kc-presentation="list"]').click();
  await expect(page.locator('[data-kc-result-row]').first()).toBeVisible();
  await noHorizontalOverflow(page, 640);
});

test('a stale reader snapshot is named with its recovery, separately from the published index', async ({
  page,
}) => {
  await page.route('**/memory/home.json', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.health = body.health ?? {};
    body.health.readerFreshness = {
      ...(body.health.readerFreshness ?? {}),
      indexedHead: 'b'.repeat(40),
      stale: true,
      staleReasons: ['head-moved'],
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  const reader = page.locator('[data-kc-health="reader"]');
  await expect(reader).toContainText('Stale');
  await expect(reader).toContainText('refresh the visualization');
  await expect(page.locator('[data-kc-health="published"]')).not.toContainText('Stale');
});

test('a partial source preview says it is truncated; a failed one can be retried', async ({
  page,
}) => {
  await routeSmallGraph(page);
  let fail = true;
  await page.route('**/source?*', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, body: 'source reader unavailable' });
      return;
    }
    await route.fulfill({
      json: {
        nodeId: 'RootAnchor',
        file: 'src/index.ts',
        span: { start: 2, end: 400 },
        excerpt: { start: 2, end: 201, text: 'export function RootAnchor() {}', truncated: true },
      },
    });
  });
  await page.goto(backend.url);
  await inspectThroughList(page);
  await page.locator('[data-kc-inspector-source] > button').click();
  await expect(page.locator('[data-kc-source-error]')).toContainText('Could not load source');
  await page.locator('[data-kc-source-retry]').click();
  await expect(page.getByText('Preview truncated at 200 lines / 64 KiB.')).toBeVisible();
});

test('the code graph shows its loading state, then an empty index states itself', async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/graph.json', async (route) => {
    await gate;
    await route.fulfill({
      json: { nodes: [], edges: [], clusters: [], stats: { nodes: 0, edges: 0, clusters: 0 } },
    });
  });
  await page.route('**/overview.json', (route) => route.fulfill({ json: { modules: [] } }));
  await page.goto(backend.url);
  await page.locator('[data-kc-presentation="list"]').click();
  await expect(page.locator('.kc-result-summary')).toHaveText('Loading code graph…');
  release();
  await expect(page.locator('.kc-result-empty')).toContainText('The code graph index is empty.');
});
