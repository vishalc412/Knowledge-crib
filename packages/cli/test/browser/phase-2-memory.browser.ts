import { type Page, expect, test } from '@playwright/test';
import { MemoryBackend } from './backend.js';
import { sampleTextContrast } from './contrast.js';

// Phase 2 — every record a Memory home tile counts is reachable through that tile. The backend
// seeds 230 degraded-evidence claims (recall-eligible AND listed in Needs review) plus one claim
// with a reported concern, so both working views need more than four 50-row pages.
const REVIEW_CLAIMS = 230;
let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend({ reviewClaims: REVIEW_CLAIMS });
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

async function openHome(page: Page) {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await expect(page.locator('[data-kc-memory-home-action="active"]')).toBeVisible({
    timeout: 20_000,
  });
}

async function tileCount(page: Page, key: string): Promise<number> {
  const text = await page.locator(`[data-kc-memory-home-action="${key}"] div`).first().innerText();
  return Number(text.trim());
}

/** Walk every page of the open view and return the distinct row ids it lists. */
async function collectRows(page: Page): Promise<Set<string>> {
  const ids = new Set<string>();
  for (;;) {
    const rows = page.locator('[data-kc-mem-row]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(50);
    for (const id of await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-kc-mem-row') ?? ''),
    )) {
      ids.add(id);
    }
    const next = page.locator('[data-kc-mem-page-next]');
    if ((await next.count()) === 0 || (await next.getAttribute('aria-disabled')) === 'true') break;
    const range = await page.locator('[data-kc-mem-page-range]').innerText();
    await next.click();
    await expect(page.locator('[data-kc-mem-page-range]')).not.toHaveText(range);
  }
  return ids;
}

test('each count tile opens the view whose predicate produced its number, across every page', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openHome(page);
  const counts = {
    active: await tileCount(page, 'active'),
    needsReview: await tileCount(page, 'needsReview'),
    history: await tileCount(page, 'history'),
  };
  expect(counts.needsReview).toBeGreaterThan(200);
  expect(counts.active).toBeGreaterThan(200);

  for (const [key, title] of [
    ['active', 'Active'],
    ['needsReview', 'Needs review'],
    ['history', 'History'],
  ] as const) {
    await page.locator(`[data-kc-memory-home-action="${key}"]`).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeFocused();
    await expect(page.locator('[data-kc-mem-page-range]')).toContainText(`of ${counts[key]}`);
    expect((await collectRows(page)).size).toBe(counts[key]);
    await page.getByRole('button', { name: 'Back to Memory home' }).click();
    await expect(page.locator(`[data-kc-memory-home-action="${key}"]`)).toBeFocused();
  }
});

test('only History shows lifecycle tabs, and the working views explain their overlap', async ({
  page,
}) => {
  await openHome(page);
  await expect(page.locator('[data-kc-mem-overlap-note]')).toContainText('can overlap');
  await page.locator('[data-kc-memory-home-action="active"]').click();
  await expect(page.getByRole('group', { name: 'Lifecycle group' })).toHaveCount(0);
  await expect(page.locator('[data-kc-mem-view]')).toContainText('Needs review');
  await page.getByRole('button', { name: 'Back to Memory home' }).click();
  await page.locator('[data-kc-memory-home-action="history"]').click();
  await expect(page.getByRole('group', { name: 'Lifecycle group' })).toBeVisible();
});

test('Needs review rows state their reason and what it means for recall', async ({ page }) => {
  await openHome(page);
  await page.locator('[data-kc-memory-home-action="needsReview"]').click();
  const reasons = page.locator('[data-kc-mem-reasons]').first();
  await expect(reasons).toBeVisible();
  await expect(page.locator('[data-kc-mem-view]')).toContainText(
    'Evidence degraded — Still recall-eligible — use with caution.',
  );
  // The reported concern appears in Needs review without leaving recall (it is advisory).
  let found = false;
  for (let page_ = 0; page_ < 6 && !found; page_ += 1) {
    found = (await page.getByText(backend.concernClaim, { exact: true }).count()) > 0;
    if (!found) {
      const range = await page.locator('[data-kc-mem-page-range]').innerText();
      await page.locator('[data-kc-mem-page-next]').click();
      await expect(page.locator('[data-kc-mem-page-range]')).not.toHaveText(range);
    }
  }
  expect(found).toBe(true);
  await expect(page.locator('[data-kc-mem-view]')).toContainText('Concern reported');
});

test('detail Back returns to the originating view, page, and row', async ({ page }) => {
  await openHome(page);
  await page.locator('[data-kc-memory-home-action="needsReview"]').click();
  await page.locator('[data-kc-mem-page-next]').click();
  await expect(page.locator('[data-kc-mem-page-range]')).toContainText('51–100');
  const row = page.locator('[data-kc-mem-row]').nth(3);
  const id = await row.getAttribute('data-kc-mem-row');
  await row.click();
  await expect(page.locator('[data-kc-mem-detail-back]')).toBeFocused();
  await page.locator('[data-kc-mem-detail-back]').click();
  await expect(page.getByRole('heading', { name: 'Needs review', exact: true })).toBeVisible();
  await expect(page.locator('[data-kc-mem-page-range]')).toContainText('51–100');
  await expect(page.locator(`[data-kc-mem-row="${id}"]`)).toBeFocused();
});

test('the Work tile counts resumable work and labels stale and closed work apart', async ({
  page,
}) => {
  await openHome(page);
  const tile = page.locator('[data-kc-memory-home-action="resume"]');
  await expect(tile).toContainText('Work history');
  await tile.click();
  await expect(page.locator('[data-kc-mem-work-summary]')).toHaveText(
    /^resumable \d+ · stale \d+ · closed \d+$/,
  );
});

test('the ledger API rejects a view combined with a group and keeps History unchanged', async () => {
  const status = async (query: string) =>
    (await fetch(`${backend.url}/memory.json?${query}`)).status;
  expect(await status('view=active&group=stale')).toBe(400);
  expect(await status('view=everything')).toBe(400);
  const history = (await backend.getJson('/memory.json?limit=1')) as {
    total: number;
    views: { active: number; needsReview: number };
    rows: { reviewReasons: unknown[] }[];
  };
  expect(history.total).toBeGreaterThan(REVIEW_CLAIMS);
  expect(Array.isArray(history.rows[0]?.reviewReasons)).toBe(true);
});

for (const scheme of ['dark', 'light'] as const) {
  test(`Memory views keep readable text in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openHome(page);
    await page.locator('[data-kc-memory-home-action="needsReview"]').click();
    await expect(page.locator('[data-kc-mem-reasons]').first()).toBeVisible();
    expect(await sampleTextContrast(page, '[data-kc-mem-view]')).toEqual([]);
  });
}
