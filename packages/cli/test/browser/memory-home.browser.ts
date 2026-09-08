// WP6 slice D — the acceptance gate for rows WP6.1–WP6.6, straight from the plan:
// "Browser tests complete admissible pending-memory and intake-resume workflows
// against a real isolated backend."
//
// Serial by design: one real backend (one repo, one viz server) for the whole file,
// and the tests walk the operator's actual journey in order — the queue as seeded,
// the ready admission, the honesty of terminal/blocked rows, the resume lifecycle
// (fresh → duplicate → stale), and finally the a11y/viewport contracts.

import { expect, test } from '@playwright/test';
import { MemoryBackend, SEEDED } from './backend.js';

let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend();
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

/** Opens the memory panel and enters one of its home views ('pending' or 'resume'). */
async function openMemoryView(page: import('@playwright/test').Page, tileTitle: string) {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  const tile = page.getByTitle(tileTitle);
  await tile.waitFor({ state: 'visible', timeout: 20_000 });
  await tile.click();
  await expect(page.locator('[data-kc-mem-action-head]')).toBeFocused();
}

test.describe
  .serial('the memory home against a real isolated backend', () => {
    test('the pending view renders the classified queue honestly', async ({ page }) => {
      await openMemoryView(page, 'Review pending outcomes');

      // The standing counts are whole-queue, never the current page.
      await expect(page.getByText('captures 1')).toBeVisible();
      await expect(page.getByText('ready 1')).toBeVisible();
      await expect(page.getByText('terminal 1')).toBeVisible();
      await expect(page.getByText('blocked 1')).toBeVisible();

      // The raw capture names the exact distill command — consent for a provider is
      // never a browser action.
      await expect(page.getByText(SEEDED.captureClaim)).toBeVisible();
      await expect(page.getByText('crib memory distill --provider <name>')).toBeVisible();

      // Three staged rows; the Admit action exists exactly once — on the ready row.
      await expect(page.getByText(SEEDED.readyClaim)).toBeVisible();
      await expect(page.getByText(SEEDED.terminalClaim)).toBeVisible();
      await expect(page.getByText(SEEDED.blockedClaim)).toBeVisible();
      await expect(page.locator('[data-kc-mem-admit]')).toHaveCount(1);
      await expect(page.locator('[data-kc-mem-admit]')).toHaveText('Admit');

      // The template engine renders paths/equalities/literals only — a raw object
      // reaching a {{ }} binding shows up as this string. None may ever ship.
      await expect(page.getByText('[object Object]')).toHaveCount(0);
    });

    test('admitting the ready claim works from the keyboard and refreshes every surface', async ({
      page,
    }) => {
      await openMemoryView(page, 'Review pending outcomes');
      const admit = page.locator('[data-kc-mem-admit]');
      await expect(admit).toHaveCount(1);

      // Keyboard-activation contract (WP6.6): focus lands on the row's action without
      // a pointer, and Enter activates it.
      await admit.focus();
      await expect(admit).toBeFocused();
      const admission = page.waitForResponse(
        (response) =>
          response.url().endsWith('/memory/admit') && response.request().method() === 'POST',
      );
      await page.keyboard.press('Enter');
      const response = await admission;
      expect(await response.text()).toEqual(expect.stringContaining('"admitted":true'));

      // The outcome announces in the visible notice AND the polite live region.
      await expect(page.locator('[data-kc-mem-admit-notice]')).toHaveText(
        'Admitted — the record is now active.',
      );
      await expect(
        page.locator('[role="status"][aria-live="polite"]', {
          hasText: 'Admitted — the record is now active.',
        }),
      ).toHaveCount(1);

      // The queue refreshes: the ready row is gone, the rest stand.
      await expect(page.getByText('ready 0')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('terminal 1')).toBeVisible();
      await expect(page.getByText('blocked 1')).toBeVisible();
      await expect(page.getByText(SEEDED.readyClaim)).toHaveCount(0);

      // The record is active in the real ledger — verified from outside the browser,
      // against the same server the page talks to.
      const ledger = JSON.stringify(await backend.getJson('/memory.json'));
      expect(ledger).toContain(SEEDED.readyClaim);
      expect(ledger).not.toContain(SEEDED.terminalClaim);
      expect(ledger).not.toContain(SEEDED.blockedClaim);
    });

    test('terminal and blocked rows stay honest after the admission', async ({ page }) => {
      await openMemoryView(page, 'Review pending outcomes');

      // No Admit action remains anywhere — the rows that cannot go through the browser
      // path offer none, silently or otherwise.
      await expect(page.locator('[data-kc-mem-admit]')).toHaveCount(0);

      // The terminal row names its exact terminal-only command.
      await expect(page.getByText(SEEDED.terminalClaim)).toBeVisible();
      await expect(page.getByText(`crib memory admit ${backend.staged.terminal}`)).toBeVisible();

      // The blocked row names the evaluate command and shows its blocker.
      await expect(page.getByText(SEEDED.blockedClaim)).toBeVisible();
      await expect(
        page.getByText(`crib memory evaluate ${backend.staged.blocked} --profile <name>`),
      ).toBeVisible();
      await expect(page.getByText(/no evidence attached/i)).toBeVisible();
    });

    test('resuming the saved intake records the decision and closes the detail', async ({
      page,
    }) => {
      await openMemoryView(page, 'Resume saved work');

      // The choice card shows the intake and its next safe action.
      const choice = page.locator(`[data-kc-mem-choice="${backend.intakeId}"]`);
      await expect(choice).toBeVisible();
      await expect(choice).toContainText(backend.intakeId);
      await expect(choice).toContainText('Re-run the browser suite against the real backend');

      // The detail: saved request, checkpoint history, focus moved into it.
      await choice.click();
      await expect(page.locator('[data-kc-mem-intake-back]')).toBeFocused();
      await expect(page.getByText('Ship the browser admission and resume flows')).toBeVisible();
      await expect(page.getByText('Checkpoint history')).toBeVisible();
      await expect(page.getByText(/progress · /)).toBeVisible();
      await expect(
        page.getByText(/Records the resume against checkpoint .+\. Nothing is executed\./),
      ).toBeVisible();

      // An empty input means "reuse the saved next action" — the server fills it.
      await page.locator('[data-kc-mem-resume-btn]').click();

      // The outcome lands at the list level (the detail closes on success) and in the
      // live region.
      await expect(page.locator('[data-kc-mem-resume-notice]')).toHaveText(
        'Resume recorded — the decision is on the intake.',
      );
      await expect(page.locator('[data-kc-mem-intake-back]')).toHaveCount(0);
      await expect(
        page.locator('[role="status"][aria-live="polite"]', {
          hasText: 'Resume recorded — the decision is on the intake.',
        }),
      ).toHaveCount(1);
    });

    test('a duplicate resume is idempotent, never a second event', async ({ page }) => {
      await openMemoryView(page, 'Resume saved work');

      // Re-open the detail — its latest checkpoint is now the recorded resume.
      const choice = page.locator(`[data-kc-mem-choice="${backend.intakeId}"]`);
      await choice.click();
      await expect(page.locator('[data-kc-mem-intake-back]')).toBeFocused();
      await expect(page.getByText(/resumed · /)).toBeVisible();

      await page.locator('[data-kc-mem-resume-btn]').click();
      await expect(page.locator('[data-kc-mem-resume-notice]')).toHaveText(
        'Already resumed — nothing to do.',
      );
      await expect(page.locator('[data-kc-mem-intake-back]')).toHaveCount(0);
    });

    test('a resume against a moved intake answers 409, re-bases, then succeeds', async ({
      page,
    }) => {
      await openMemoryView(page, 'Resume saved work');

      const choice = page.locator(`[data-kc-mem-choice="${backend.intakeId}"]`);
      await choice.click();
      await expect(page.locator('[data-kc-mem-intake-back]')).toBeFocused();

      // Another session records a checkpoint while this form is open.
      await backend.concurrentCheckpoint('Another session moved the work forward');

      await page.locator('[data-kc-mem-resume-btn]').click();

      // The server's stale message surfaces verbatim; the form re-bases on the new
      // latest checkpoint (loadIntakeDetail re-ran), so the retry is not a blind replay.
      await expect(
        page.getByText('the intake changed since it was loaded — reload and retry'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-kc-mem-intake-back]')).toHaveCount(1);

      await page.locator('[data-kc-mem-resume-btn]').click();
      await expect(page.locator('[data-kc-mem-resume-notice]')).toHaveText(
        'Resume recorded — the decision is on the intake.',
        { timeout: 20_000 },
      );
      await expect(page.locator('[data-kc-mem-intake-back]')).toHaveCount(0);
    });

    test('Escape closes the panel and restores focus to the trigger', async ({ page }) => {
      await openMemoryView(page, 'Resume saved work');
      await expect(page.locator('[data-kc-mem-resume-list]')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.locator('[data-kc-mem-resume-list]')).toHaveCount(0);
      await expect(page.locator('[data-kc-memory-trigger]')).toBeFocused();
    });

    test('the panel works at 390px with no horizontal overflow', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openMemoryView(page, 'Review pending outcomes');

      await expect(page.getByText('terminal 1')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });
