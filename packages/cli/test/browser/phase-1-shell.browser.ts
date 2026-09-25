import { type Page, expect, test } from '@playwright/test';
import { MemoryBackend } from './backend.js';
import { sampleTextContrast, undersizedTargets } from './contrast.js';

let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend();
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

test('the semantic token sheet is served offline with a CSS content type', async ({ request }) => {
  const response = await request.get(`${backend.url}/tokens.css`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/css/);
  expect(await response.text()).toContain('--kc-surface-floating');
});

test('theme follows the system until the user makes a persistent choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(backend.url);
  const shell = page.locator('[data-kc-shell]');
  await expect(shell).toHaveAttribute('data-kc-theme', 'light');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(shell).toHaveAttribute('data-kc-theme', 'dark');
  await page.reload();
  await expect(shell).toHaveAttribute('data-kc-theme', 'dark');
  await page.evaluate(() => localStorage.setItem('knowledge-crib:theme', 'invalid'));
  await page.reload();
  await expect(shell).toHaveAttribute('data-kc-theme', 'light');
});

test('blocked local storage falls back to the system theme without breaking the toggle', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
    });
  });
  await page.goto(backend.url);
  const shell = page.locator('[data-kc-shell]');
  await expect(shell).toHaveAttribute('data-kc-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(shell).toHaveAttribute('data-kc-theme', 'light');
});

test('mobile navigation is an opaque modal drawer with focus and Escape return', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(backend.url);
  const trigger = page.locator('[data-kc-rail-toggle]');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const drawer = page.getByRole('dialog', { name: 'Repository navigation' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Browse repository' })).toBeFocused();
  await expect(page.locator('[data-kc-graph-stage]')).toHaveAttribute('inert', '');
  const opacity = await drawer.evaluate((element) =>
    Number(getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.[3] ?? 1),
  );
  expect(opacity).toBe(1);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.locator('[data-kc-graph-stage]')).not.toHaveAttribute('inert');
});

test('mobile inspector and Help close by keyboard and return focus', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(backend.url);
  // Phones open in List (Phase 3); the inspector toggle is part of the Graph presentation.
  await page.locator('[data-kc-presentation="graph"]').click();
  const inspectorTrigger = page.locator('[data-kc-inspector-toggle]');
  await inspectorTrigger.focus();
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('dialog', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  await expect(page.locator('[data-kc-graph-stage]')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(inspectorTrigger).toBeFocused();
  const helpTrigger = page.getByRole('button', { name: 'Keyboard shortcuts and help' });
  await helpTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close keyboard shortcuts' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(helpTrigger).toBeFocused();
});

test('the graph has a page heading and a persistent search label', async ({ page }) => {
  await page.goto(backend.url);
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge-Crib' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search graph' })).toBeVisible();
});

test('the theme choice is stored under the documented key and the toggle names its action', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(backend.url);
  const toggle = page.locator('[data-kc-theme-toggle]');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');
  expect(await page.evaluate(() => localStorage.getItem('knowledge-crib:theme'))).toBe('light');
});

test('the canvas paints from the active theme tokens', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(backend.url);
  const cornerPixel = () =>
    page
      .locator('[data-kc-graph-stage] canvas')
      .first()
      .evaluate((canvas) => {
        const context = (canvas as HTMLCanvasElement).getContext('2d')!;
        // Away from the canvas dot grid: overview layout can place a dot at (2, 2).
        return Array.from(context.getImageData(8, 8, 1, 1).data.slice(0, 3));
      });
  await expect.poll(cornerPixel).toEqual([12, 15, 22]);
  await page.locator('[data-kc-theme-toggle]').click();
  await expect.poll(cornerPixel).toEqual([244, 246, 249]);
});

async function openLayerFor(page: Page, width: number) {
  if (width > 760) await page.locator('[data-kc-inspector-toggle]').click();
  else await page.locator('[data-kc-rail-toggle]').click();
}

for (const scheme of ['dark', 'light'] as const) {
  for (const width of [1280, 375]) {
    test(`shell text contrast and target sizes hold in ${scheme} at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 850 });
      await page.goto(backend.url);
      await expect(page.locator('[data-kc-shell]')).toHaveAttribute('data-kc-theme', scheme);
      const minimum = width <= 760 ? 44 : 32;
      // Closed state first, then with the width's primary layer open (inspector or drawer).
      expect(await sampleTextContrast(page, '[data-kc-shell]')).toEqual([]);
      expect(await undersizedTargets(page, '[data-kc-shell]', minimum)).toEqual([]);
      await openLayerFor(page, width);
      expect(await sampleTextContrast(page, '[data-kc-shell]')).toEqual([]);
      expect(await undersizedTargets(page, '[data-kc-shell]', minimum)).toEqual([]);
      await testInfo.attach(`shell-${scheme}-${width}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });
  }
}

test('headings form an ordered outline that starts at the page heading', async ({ page }) => {
  await page.goto(backend.url);
  await page.locator('[data-kc-inspector-toggle]').click();
  const levels = await page.evaluate(() =>
    [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter((heading) => !heading.closest('[inert]'))
      .map((heading) => Number(heading.tagName.slice(1))),
  );
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index] - levels[index - 1]).toBeLessThanOrEqual(1);
  }
});

test('the search shortcut follows the platform', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });
  await page.goto(backend.url);
  await expect(page.locator('[data-kc-search-shortcut]')).toHaveText('Ctrl K');
  await page.locator('[data-kc-help-trigger]').click();
  await expect(page.locator('[data-kc-help]')).toContainText('Ctrl K');
});

test('at 400% zoom (320 × 256 CSS px) the shell reflows and navigation stays reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto(backend.url);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(320);
  await page.locator('[data-kc-rail-toggle]').click();
  const drawer = page.getByRole('dialog', { name: 'Repository navigation' });
  const lastType = drawer.locator('.kc-rail-item').last();
  await lastType.scrollIntoViewIfNeeded();
  await expect(lastType).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible();
});

test('keyboard opening moves focus into the inspector; pointer opening does not', async ({
  page,
}) => {
  await page.goto(backend.url);
  const toggle = page.locator('[data-kc-inspector-toggle]');
  await toggle.click();
  await expect(page.locator('[data-kc-inspector-placeholder]')).toBeVisible();
  await expect(toggle).toBeFocused();
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(toggle).toBeFocused();

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-kc-inspector-heading]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
});

test('Memory contains focus while open and leaves only its own trigger operable', async ({
  page,
}) => {
  await page.goto(backend.url);
  const trigger = page.locator('[data-kc-memory-trigger]');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-kc-memory-close]')).toBeFocused();
  await expect(page.locator('[data-kc-graph-stage]')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-kc-navigation-rail]')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-kc-theme-toggle]')).toHaveAttribute('inert', '');
  await expect(trigger).not.toHaveAttribute('inert');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[inert]')).toHaveCount(0);
});

test('widening past the mobile breakpoint closes the drawer and keeps the desktop rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(backend.url);
  await page.locator('[data-kc-rail-toggle]').click();
  await expect(page.getByRole('dialog', { name: 'Repository navigation' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('dialog', { name: 'Repository navigation' })).toHaveCount(0);
  await expect(page.locator('[data-kc-rail-toggle]')).toHaveAttribute(
    'aria-label',
    'Collapse navigation',
  );
  await expect(page.locator('[inert]')).toHaveCount(0);
});
