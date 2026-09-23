import { type Page, expect, test } from '@playwright/test';
import { MemoryBackend } from './backend.js';

// Phase 6 — keyboard and focus criteria axe cannot judge on its own: every tab stop shows a
// visible focus indicator (2.4.7) that is not hidden behind other content (2.4.11), modal layers
// keep Tab inside themselves (2.4.3 / APG dialog), a whole Memory review task completes without a
// pointer (2.1.1), and reduced motion is honoured (2.3.3 support).
let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend({ evidenceKinds: true });
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

interface Stop {
  label: string;
  visibleFocus: boolean;
  obscured: boolean;
  insideSelector: boolean;
}

/** Press Tab `count` times and describe each focused element. */
async function tabStops(page: Page, count: number, within?: string): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(
      await page.evaluate((selector) => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) {
          return { label: 'body', visibleFocus: false, obscured: false, insideSelector: false };
        }
        const style = getComputedStyle(el);
        const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
        const ring = style.boxShadow !== 'none';
        const box = el.getBoundingClientRect();
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const after = el.getBoundingClientRect();
        const x = after.left + Math.min(after.width / 2, 8);
        const y = after.top + after.height / 2;
        const top = document.elementFromPoint(x, y);
        const obscured = !!top && top !== el && !el.contains(top) && !top.contains(el);
        return {
          label:
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            (el.textContent ?? '').trim().slice(0, 40) ||
            el.tagName,
          visibleFocus: (outline || ring) && box.width > 0,
          obscured,
          insideSelector: selector ? !!el.closest(selector) : true,
        };
      }, within ?? null),
    );
  }
  return stops;
}

test('every desktop tab stop has a visible, unobscured focus indicator', async ({ page }) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-inspector-toggle]').click(); // include the inspector's stops
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const stops = await tabStops(page, 45);
  const bad = stops.filter((s) => s.label !== 'body' && (!s.visibleFocus || s.obscured));
  expect(bad).toEqual([]);
  const labels = stops.map((s) => s.label);
  for (const expected of [
    /^Search code/,
    /^Switch to (light|dark) theme$/,
    /^Keyboard shortcuts/,
  ]) {
    expect(labels.some((l) => expected.test(l))).toBe(true);
  }
  // Focus order follows the visual order: the header's search comes before the stage controls.
  const search = labels.findIndex((l) => /^Search code/.test(l));
  const stage = labels.findIndex((l) => /inspector$/.test(l));
  expect(search).toBeGreaterThan(-1);
  expect(stage).toBeGreaterThan(search);
});

test('Memory keeps Tab inside itself and its trigger, with visible focus throughout', async ({
  page,
}) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-kc-memory-close]')).toBeFocused();
  const stops = await tabStops(page, 30, '[data-kc-memory-panel], [data-kc-memory-trigger]');
  expect(stops.filter((s) => !s.insideSelector)).toEqual([]);
  expect(stops.filter((s) => !s.visibleFocus || s.obscured)).toEqual([]);
});

test('the phone navigation drawer keeps Tab inside itself', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(backend.url);
  await page.locator('[data-kc-rail-toggle]').focus();
  await page.keyboard.press('Enter');
  const stops = await tabStops(page, 20, '[data-kc-navigation-rail]');
  expect(stops.filter((s) => !s.insideSelector)).toEqual([]);
  expect(stops.filter((s) => !s.visibleFocus || s.obscured)).toEqual([]);
});

test('a complete Memory review runs without a pointer', async ({ page }) => {
  await page.goto(backend.url);
  // Open Memory with its keyboard shortcut, then reach the History tile by Tab.
  await page.locator('body').press('m');
  await expect(page.locator('[data-kc-memory-close]')).toBeFocused();
  const history = page.locator('[data-kc-memory-home-action="history"]');
  for (
    let i = 0;
    i < 15 && !(await history.evaluate((el) => el === document.activeElement));
    i += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(history).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeFocused();

  const row = page.locator(`[data-kc-mem-row="${backend.evidenceRecordId}"]`);
  for (let i = 0; i < 40 && !(await row.evaluate((el) => el === document.activeElement)); i += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-kc-mem-detail-back]')).toBeFocused();

  const inspect = page.locator('[data-kc-mem-evidence-inspect="0"]');
  for (
    let i = 0;
    i < 20 && !(await inspect.evaluate((el) => el === document.activeElement));
    i += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(inspect).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(inspect).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-kc-mem-evidence-excerpt]')).toBeVisible();

  const report = page.locator('[data-kc-mem-concern-open]');
  for (
    let i = 0;
    i < 40 && !(await report.evaluate((el) => el === document.activeElement));
    i += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(report).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-kc-mem-concern-reason]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-kc-memory-trigger]')).toBeFocused();
  await expect(page.locator('[data-kc-memory-panel]')).toHaveCount(0);
});

test('reduced motion removes panel animation and transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  const duration = await page
    .locator('[data-kc-memory-panel]')
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeLessThanOrEqual(0.001);
});

test('canvas hover content can be hovered and dismissed with Escape (WCAG 1.4.13)', async ({
  page,
}) => {
  await page.route('**/graph.json', (route) =>
    route.fulfill({
      json: {
        nodes: [
          { id: 'Solo', label: 'Solo', kind: 'function', importance: 1, summary: 'A lone node.' },
        ],
        edges: [],
        clusters: [],
        stats: { nodes: 1, edges: 0, clusters: 0 },
      },
    }),
  );
  await page.route('**/overview.json', (route) => route.fulfill({ json: { modules: [] } }));
  await page.goto(backend.url);
  await page.getByPlaceholder('Search code, docs, tables…').fill('Solo');
  await expect(page.locator('[data-kc-search-status]')).toContainText('1 code graph match');
  const box = (await page.locator('[data-kc-graph-stage]').boundingBox())!;
  const zoom =
    Number(
      (await page.locator('[data-kc-stage-zoom] button').nth(1).innerText()).replace('%', ''),
    ) / 100;
  const node = { x: box.x + box.width / 2, y: box.y + box.height / 2 - 20 * zoom };
  await page.mouse.move(node.x, node.y);
  const tip = page.locator('[data-kc-tooltip]');
  await expect(tip).toBeVisible();
  const tipBox = (await tip.boundingBox())!;
  await page.mouse.move(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2, { steps: 6 });
  await page.waitForTimeout(500);
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});

test('single-key shortcuts can be turned off and stay off (WCAG 2.1.4)', async ({ page }) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-help-trigger]').click();
  const toggle = page.locator('[data-kc-single-key-toggle]');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await page.locator('body').press('m');
  await expect(page.locator('[data-kc-memory-panel]')).toHaveCount(0);
  await page.reload();
  await page.locator('body').press('m');
  await expect(page.locator('[data-kc-memory-panel]')).toHaveCount(0);
  // Modified keys never trigger a single-key shortcut, even when shortcuts are on.
  await page.evaluate(() => localStorage.removeItem('knowledge-crib:single-key-shortcuts'));
  await page.reload();
  await page.locator('body').press('Alt+m');
  await expect(page.locator('[data-kc-memory-panel]')).toHaveCount(0);
  await page.locator('body').press('m');
  await expect(page.locator('[data-kc-memory-panel]')).toBeVisible();
});

test('the search result count is announced through a polite live region (WCAG 4.1.3)', async ({
  page,
}) => {
  await page.goto(backend.url);
  const live = page.locator('[data-kc-search-live]');
  await expect(live).toHaveAttribute('role', 'status');
  await page.getByPlaceholder('Search code, docs, tables…').fill('normalizeInput');
  await expect(live).toContainText('match');
  await page.getByPlaceholder('Search code, docs, tables…').fill('no-such-symbol-2026');
  await expect(live).toContainText('No code graph matches');
});
