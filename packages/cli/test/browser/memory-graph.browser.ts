// WP-G7 — the Connections and History workflows of the memory home, against a real isolated
// backend (real `crib viz`, real stores, a real connected graph). Every graph detail is a list,
// so each assertion here is also the keyboard and screen-reader contract.

import { expect, test } from '@playwright/test';
import { MemoryBackend, SEEDED_GRAPH } from './backend.js';

let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend();
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

async function openCurrentClaim(page: import('@playwright/test').Page) {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  const row = page.locator(`[data-kc-mem-row="${backend.graph.current}"]`);
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
  await expect(page.locator('[data-kc-mem-detail-back]')).toBeFocused();
  await expect(page.locator('[data-kc-mem-connections-head]')).toHaveText('Connections (3)', {
    timeout: 20_000,
  });
}

test.describe
  .serial('memory graph connections and history', () => {
    test('a claim lists its authorized code, replaced claim, and linked work', async ({ page }) => {
      await openCurrentClaim(page);
      const connections = page.locator('[data-kc-mem-connections] > li');
      await expect(connections).toHaveCount(3);
      await expect(page.locator(`[data-kc-mem-connection="${backend.sym.id}"]`)).toContainText(
        'about · code',
      );
      await expect(
        page.locator(`button[data-kc-mem-connection="${backend.graph.retired}"]`),
      ).toContainText('supersedes · claim · open');
      await expect(
        page.locator(`button[data-kc-mem-connection="${backend.intakeId}"]`),
      ).toContainText('← about · work · open');
      await expect(page.getByText('[object Object]')).toHaveCount(0);
    });

    test('a replaced claim opens as history and Back walks the trail with focus return', async ({
      page,
    }) => {
      await openCurrentClaim(page);
      const retired = page.locator(`button[data-kc-mem-connection="${backend.graph.retired}"]`);
      await retired.focus();
      await page.keyboard.press('Enter');

      await expect(page.getByText(SEEDED_GRAPH.retiredClaim).first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator('[data-kc-mem-graph-state]')).toHaveText(
        'This claim is history: it has been replaced and no longer counts as current.',
      );
      await expect(
        page.locator(`[data-kc-mem-replaced-by="${backend.graph.current}"]`),
      ).toBeVisible();
      await expect(page.locator('[data-kc-mem-history] > li')).toHaveCount(1);
      await expect(page.locator('[data-kc-mem-history]')).toContainText(
        'sym:src/index.ts#legacyHash',
      );

      const back = page.locator('[data-kc-mem-detail-back]');
      await expect(back).toHaveText('← Back to the previous claim');
      await back.click();
      await expect(page.locator('[data-kc-mem-connections-head]')).toHaveText('Connections (3)', {
        timeout: 20_000,
      });
      await expect(back).toHaveText('← Back to ledger');
      await back.click();
      await expect(page.locator(`[data-kc-mem-row="${backend.graph.current}"]`)).toBeFocused();
    });

    test('linked work opens the authorized intake detail', async ({ page }) => {
      await openCurrentClaim(page);
      await page.locator(`button[data-kc-mem-connection="${backend.intakeId}"]`).click();
      await expect(page.locator('[data-kc-mem-intake-back]')).toBeFocused({ timeout: 20_000 });
      await expect(page.getByText('Ship the browser admission and resume flows')).toBeVisible();
    });

    test('Escape dismisses the panel from a claim detail and returns focus', async ({ page }) => {
      await openCurrentClaim(page);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-kc-mem-connections]')).toHaveCount(0);
      await expect(page.locator('[data-kc-memory-trigger]')).toBeFocused();
    });

    test('connections are a usable list/detail flow at 390px with no horizontal overflow', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openCurrentClaim(page);
      await expect(page.locator('[data-kc-mem-connections] > li')).toHaveCount(3);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });
