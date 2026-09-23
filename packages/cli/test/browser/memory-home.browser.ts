// WP6 slice D — the acceptance gate for rows WP6.1–WP6.6, straight from the plan:
// "Browser tests complete admissible pending-memory and intake-resume workflows
// against a real isolated backend."
//
// Serial by design: one real backend (one repo, one viz server) for the whole file,
// and the tests walk the operator's actual journey in order — the queue as seeded,
// the ready admission, the honesty of terminal/blocked rows, the resume lifecycle
// (fresh → duplicate → stale), and finally the a11y/viewport contracts.
//
// WP5 T16–T20 are appended to that same serial describe, because they are the same journey's
// remaining states: what the panel says when there is nothing (T16), when the server is gone (T17),
// when a claim has been excluded from recall (T18), the one U5 workflow end to end (T19), and the
// keyboard/contrast contract over the new surfaces (T20).
//
// TWO HONEST LIMITS recorded here rather than in a commit message:
//
// 1. T16 cannot exercise the `configured: false` branch. That branch is `readMemoryHome`'s
//    `if (!api)` arm, and `api` exists whenever `.crib/crib.json` has a repo id — the SAME file
//    `crib viz` requires to start at all (`isIndexedRoot`). So through this server, "no memory
//    configured" is unreachable by construction, and T16 tests the state that IS reachable: an
//    indexed repo whose stores are simply empty. The unreachable arm's coverage belongs at the
//    viz-server boundary, where a fixture can call `readMemoryHome(undefined, …)` directly.
// 2. T19 deviates from U5's literal "save a decision". The `decision` kind admits only
//    human-attestation / committed-policy evidence — neither of which can change when the code on
//    disk does — so a `decision` could never produce the "change its evidence → observe the changed
//    status" leg. The row it saves is a `fact` with source-quote evidence, which is the kind whose
//    grounding the code can actually invalidate.

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

/** The ledger's own row shape, as far as these tests read it. */
interface LedgerRowShape {
  id: string;
  group: string;
  eligible: boolean;
  excludedBy?: string;
  reasons?: string[];
  evidenceVerdict: string;
}

/** One ledger row read straight from the server the page talks to. */
async function serverRow(id: string, query = ''): Promise<LedgerRowShape | undefined> {
  const ledger = (await backend.getJson(`/memory.json${query}`)) as {
    rows: LedgerRowShape[];
    revalidated: boolean;
  };
  return ledger.rows.find((r) => r.id === id);
}

/** Opens the memory panel and enters one of its home views ('pending' or 'resume'). */
async function openMemoryView(page: import('@playwright/test').Page, tileTitle: string) {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  const tile = page.getByTitle(tileTitle);
  await tile.waitFor({ state: 'visible', timeout: 20_000 });
  await tile.click();
  await expect(page.locator('[data-kc-mem-action-head]')).toBeFocused();
}

/**
 * Opens the panel on its DEFAULT view — the lifecycle ledger, not one of the home tiles. The tabs
 * are the ledger's own marker: they exist only inside `mem.list`, which is `configured && !detail`.
 */
async function openLedger(page: import('@playwright/test').Page, url = backend.url) {
  await page.goto(url);
  await page.locator('[data-kc-memory-trigger]').click();
  await expect(page.locator('[data-kc-mem-tab="All"]')).toBeVisible({ timeout: 20_000 });
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

      // The raw capture is listed under the re-check path (3ccbc06e replaced the distill
      // command with re-checking against today's code). Consent for an external model is
      // still never a browser action: no distill command or action is offered.
      await expect(page.getByText(SEEDED.captureClaim)).toBeVisible();
      await expect(
        page.getByText(
          'Admits every capture whose evidence verifies against the code today. Nothing is deleted.',
        ),
      ).toBeVisible();
      await expect(page.getByText('crib memory distill --provider <name>')).toHaveCount(0);

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
      await openMemoryView(page, 'Continue, finish or cancel saved work');

      // The choice card shows the intake and its next safe action.
      const choice = page.locator(`[data-kc-mem-choice="${backend.intakeId}"]`);
      await expect(choice).toBeVisible();
      // 3ccbc06e titles work by its outcome; the id stays on the data attribute.
      await expect(choice).toContainText('The memory home works end to end from a real browser');
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
      await openMemoryView(page, 'Continue, finish or cancel saved work');

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
      await openMemoryView(page, 'Continue, finish or cancel saved work');

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
      await openMemoryView(page, 'Continue, finish or cancel saved work');
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

    test('T16 an empty store says what was searched instead of reporting success', async ({
      page,
    }) => {
      // The second backend exists for exactly one reason: `{ seed: false }` boots the same real
      // stack (indexed repo, real viz server, real memory API) with NOTHING recorded, and the
      // memory API reports `configured: true` with zero rows regardless of whether the store
      // directory exists — so this state is reachable WITHOUT faking a payload. See the file header
      // for why the `configured: false` arm is not reachable through the server at all.
      const empty = new MemoryBackend({ seed: false });
      await empty.start();
      try {
        // Server side first: the empty state is a SUCCESSFUL read of an empty store, not a failure
        // being dressed up, and not the not-configured shape either.
        const ledger = (await empty.getJson('/memory.json')) as {
          configured: boolean;
          rows: unknown[];
        };
        expect(ledger.configured).toBe(true);
        expect(ledger.rows).toEqual([]);
        const home = (await empty.getJson('/memory/home.json')) as { configured: boolean };
        expect(home.configured).toBe(true);

        await openLedger(page, empty.url);

        const state = page.locator('[data-kc-mem-empty]');
        await expect(state).toBeVisible({ timeout: 20_000 });
        const message = (await state.textContent()) ?? '';

        // It says what was searched — the whole ledger, here — and never "all good".
        expect(message).toContain('No memories yet.');
        expect(message).toContain('Agents record what they learn with memory_observe');
        expect(message).not.toMatch(
          /all (good|clear)|nothing (to do|needs you|to worry)|everything is (fine|ok)|no issues|healthy/i,
        );

        // Nothing was invented to sit under it: no rows, and no error block — an empty store is not
        // a failure, and reporting it as one would send the operator to repair the wrong thing.
        await expect(page.locator('[data-kc-mem-row]')).toHaveCount(0);
        await expect(page.locator('[data-kc-mem-error]')).toHaveCount(0);

        // And when a lifecycle filter is in force the message changes with the question asked,
        // rather than repeating the unfiltered one.
        await page.locator('[data-kc-mem-tab="Stale"]').click();
        await expect(state).toHaveText(
          'No records match this lifecycle view. Return to All or inspect Needs review above.',
        );
      } finally {
        await empty.dispose();
      }
    });

    test('T17 an unreachable server is reported as offline, and the last read stays readable', async ({
      page,
    }) => {
      // A successful read first, so there IS last-known content to keep.
      await openLedger(page);
      await expect(page.locator(`[data-kc-mem-row="${backend.driftedId}"]`)).toBeVisible({
        timeout: 20_000,
      });

      // Then the server goes away. Aborting the request is the browser's own failure mode, which is
      // the shape the panel must survive — not an HTTP error, which the server would have to answer.
      await page.route('**/memory**', (route) => route.abort());

      // Force a re-read in place. The All tab is already on; clicking it re-issues `loadMemory(null)`
      // without clearing `memData` (only toggle/close clear it), so this is the same panel re-reading.
      await page.locator('[data-kc-mem-tab="All"]').click();

      const error = page.locator('[data-kc-mem-error="offline"]');
      await expect(error).toBeVisible({ timeout: 20_000 });
      await expect(error).toContainText('Cannot reach the crib server');
      await expect(error).toContainText('The viz server behind this panel is not answering');
      // The repair names the command, in backticks — asserted in pieces so the assertion is about the
      // instruction, not about how it is decorated.
      await expect(error).toContainText('Start it with');
      await expect(error).toContainText('crib viz');
      await expect(error).toContainText('then reopen this panel');

      // It is the OFFLINE shape, not the server-answered one — the two send the operator to repair
      // different things, and the message text alone cannot tell them apart.
      await expect(page.locator('[data-kc-mem-error="server"]')).toHaveCount(0);
      await expect(error).not.toContainText('The server answered');

      // The last successful read is still on screen, and the panel SAYS that is what it is.
      await expect(error).toContainText('The rows below are the last read that succeeded.');
      const kept = page.locator(`[data-kc-mem-row="${backend.driftedId}"]`);
      await expect(kept).toBeVisible();
      await expect(kept).toContainText(SEEDED.driftedClaim);
    });

    test('T18 an excluded claim is inspectable, and its reason is the evaluator’s own', async ({
      page,
    }) => {
      // The load-bearing fact of §7.1's correction, read from the server: this record's GROUP says
      // `current` — the group is anchor-derived and does not move when evidence stops grounding —
      // while the recall gate has already dropped it. `reasons` is what makes that visible.
      const fresh = await serverRow(backend.driftedId);
      expect(fresh, 'the drifted seed is missing from the ledger').toBeDefined();
      expect(fresh?.group).toBe('current');
      expect(fresh?.evidenceVerdict).toBe('invalid');
      expect(fresh?.eligible).toBe(false);
      expect(fresh?.excludedBy).toBe('evidence');
      expect(fresh?.reasons).toContain(SEEDED.driftedReason);

      // The cheap read disagrees — it reports the STAMP, which still claims the evidence is valid.
      // This pair is the defect the surface exists to expose: the same record, read two ways, one of
      // which says it is healthy. `revalidate: false` must never become the default.
      const stamped = await serverRow(backend.driftedId, '?revalidate=0');
      expect(stamped?.evidenceVerdict).toBe('valid');
      expect(stamped?.eligible).toBe(true);
      expect(stamped?.excludedBy).toBeUndefined();

      await openLedger(page);

      const row = page.locator(`[data-kc-mem-row="${backend.driftedId}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });

      // The trap, rendered: the row's group label reads as a healthy one beside its exclusion.
      await expect(row).toContainText('Current');

      // U1/U4 — the exclusion is visible from the list, and the reason is the evaluator's code as
      // words, in the same string the vocabulary test cross-checks against `ItemReason`.
      const panel = row.locator('[data-kc-mem-excluded="evidence"]');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('Not recalled · evidence');
      await expect(panel).toContainText(
        'Held out of recall because its evidence no longer grounds against the code.',
      );
      await expect(row.locator(`[data-kc-mem-reason="${SEEDED.driftedReason}"]`)).toHaveText(
        `${SEEDED.driftedReason} · ${SEEDED.driftedReasonText}`,
      );

      // And the same answer on the record's own view, from the detail route's own re-check.
      await row.click();
      await expect(page.locator('[data-kc-mem-detail-back]')).toBeFocused();
      await expect(page.locator('[data-kc-mem-detail-excluded="evidence"]')).toBeVisible();
      await expect(
        page.locator(`[data-kc-mem-detail-reason="${SEEDED.driftedReason}"]`),
      ).toHaveText(`${SEEDED.driftedReason} · ${SEEDED.driftedReasonText}`);
    });

    test('T19 U5 — save a claim, change the code under it, see the status change, continue the work', async ({
      page,
    }) => {
      // Its own resumable intake: the shared one was resumed three times by the tests above and
      // would answer "Already resumed — nothing to do." (which is itself tested, up there).
      const intakeId = backend.newIntake({
        from: 'Keep the lookup token claim honest',
        outcome: 'The saved claim tracks the code it is anchored to',
        accept: 'The panel shows the claim leaves recall when the code moves',
        next: 'Re-check the claim after the next code change',
      });

      // 1. Save the claim the way an agent does — through the real CLI, verified by the real gate.
      //    `observe()` throws unless the CLI reports it ACTIVE, so a staged observation cannot make
      //    the rest of this test pass while asserting nothing.
      const recordId = backend.observe(SEEDED.observedClaim, SEEDED.sourceBodyLine);
      const saved = await serverRow(recordId);
      expect(saved?.eligible).toBe(true);
      expect(saved?.evidenceVerdict).toBe('valid');

      await openLedger(page);
      const row = page.locator(`[data-kc-mem-row="${recordId}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText(SEEDED.observedClaim);
      await expect(row.locator('[data-kc-mem-excluded]')).toHaveCount(0);

      // 2. Change the code the claim quotes. No re-index: the evaluator rehydrates the span from the
      //    FILE at request time, while anchors resolve against the persisted node list — so the
      //    evidence moves and the ledger group does not.
      backend.editSourceBodyLine(SEEDED.editedBodyLine);

      // 3. Observe the changed status, in the browser, with no manual step.
      await page.locator('[data-kc-mem-tab="All"]').click();
      await expect(row.locator('[data-kc-mem-excluded="evidence"]')).toBeVisible({
        timeout: 20_000,
      });
      await expect(row.locator(`[data-kc-mem-reason="${SEEDED.observedReason}"]`)).toHaveText(
        `${SEEDED.observedReason} · ${SEEDED.observedReasonText}`,
      );
      // Still `current` in the group — the same correction T18 asserts, from a record this test
      // created rather than one the fixture seeded.
      const after = await serverRow(recordId);
      expect(after?.group).toBe('current');
      expect(after?.eligible).toBe(false);
      expect(after?.reasons).toContain(SEEDED.observedReason);

      // 4. Continue the saved work in the same session.
      await page
        .locator('[data-kc-memory-home-action][title="Continue, finish or cancel saved work"]')
        .click();
      const choice = page.locator(`[data-kc-mem-choice="${intakeId}"]`);
      await expect(choice).toBeVisible({ timeout: 20_000 });
      await choice.click();
      await expect(page.locator('[data-kc-mem-intake-back]')).toBeFocused();
      await page.locator('[data-kc-mem-resume-btn]').click();
      await expect(page.locator('[data-kc-mem-resume-notice]')).toHaveText(
        'Resume recorded — the decision is on the intake.',
        { timeout: 20_000 },
      );
    });

    test('T20 the new surfaces are keyboard-operable, focus is never lost, and contrast holds', async ({
      page,
    }) => {
      await page.goto(backend.url);

      // Arrive by keyboard only: Tab from the document until the trigger is focused. A bounded loop
      // rather than a `.focus()` call, because the question is whether it is REACHABLE.
      let reached = 0;
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        if (
          await page
            .locator('[data-kc-memory-trigger]')
            .evaluate((el) => el === document.activeElement)
        ) {
          reached = i + 1;
          break;
        }
      }
      expect(reached, 'the memory trigger is unreachable by Tab').toBeGreaterThan(0);

      await page.keyboard.press('Enter');
      // Opening the panel moves focus INTO it — the close control is where a keyboard user lands.
      await expect(page.locator('[data-kc-memory-close]')).toBeFocused({ timeout: 20_000 });
      await expect(page.locator('[data-kc-mem-tab="All"]')).toBeVisible({ timeout: 20_000 });

      // Walk forward until both a lifecycle tab and the excluded row have been reached.
      //
      // WHAT IS ASSERTED, precisely. Pressing Tab moves focus to a live element, but this panel's
      // template engine re-stamps its `sc-for` clones, so the node Tab just landed on can be detached
      // a moment later while `document.activeElement` still points at it — a real, observed
      // render-loss (the first run of this test failed here with a detached
      // `button[data-dc-tpl][data-kc-memory-home-action]`). `keepFocus` exists to REPAIR exactly
      // that, so the contract is "focus recovers onto a connected element and is never left on the
      // body" — not "focus is never momentarily stale", which the design does not claim and does not
      // deliver. So each step is given the repair's own bounded window to settle before it is judged.
      const readFocus = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          const he = el instanceof HTMLElement ? el : null;
          return {
            lost: he === null || he === document.body,
            connected: he?.isConnected ?? false,
            // What was focused, for the failure message — a bare "detached node" says nothing about
            // which node, and the repair loop makes that the whole question.
            desc: he
              ? `${he.tagName.toLowerCase()}${he.id ? `#${he.id}` : ''}` +
                ` [${he
                  .getAttributeNames()
                  .filter((n) => n.startsWith('data-'))
                  .join(' ')}]` +
                ` parent=${he.parentElement?.tagName.toLowerCase() ?? 'none'}`
              : String(el?.nodeName),
            tab: he?.dataset.kcMemTab ?? '',
            row: he?.dataset.kcMemRow ?? '',
            excluded:
              he?.querySelector('[data-kc-mem-excluded]')?.getAttribute('data-kc-mem-excluded') ??
              '',
          };
        });
      const settleFocus = async () => {
        let active = await readFocus();
        // A bounded wait on the repair, never on the traversal: if focus is already connected this
        // costs one evaluation, and if it is stale the loop gives `keepFocus` its chance and then
        // reports whatever state remains.
        for (let tick = 0; tick < 20 && (active.lost || !active.connected); tick++) {
          await page.waitForTimeout(50);
          active = await readFocus();
        }
        return active;
      };

      const visited = { tab: false, row: false };
      let carriedPanel = false;
      for (let i = 0; i < 40 && !(visited.tab && visited.row); i++) {
        await page.keyboard.press('Tab');
        const active = await settleFocus();
        expect(active.lost, `Tab ${i + 1} left focus on the document body`).toBe(false);
        expect(
          active.connected,
          `Tab ${i + 1} left focus detached after the repair window: ${active.desc}`,
        ).toBe(true);
        if (active.tab === 'Stale') visited.tab = true;
        if (active.row === backend.driftedId) {
          visited.row = true;
          carriedPanel = active.excluded === 'evidence';
        }
      }
      expect(visited.tab, 'no lifecycle tab was reachable by Tab').toBe(true);
      expect(visited.row, 'the excluded row was not reachable by Tab').toBe(true);
      expect(carriedPanel, 'the excluded row carried no exclusion panel').toBe(true);

      // ── Contrast, measured on the LIST, in both themes ───────────────────────────────────────
      //
      // Measured against the background the text is really painted on. The exclusion panel is a
      // `t.chip` surface over the translucent panel over the opaque root, and the same token earns
      // ≈4.73:1 against the panel but ≈4.34:1 where the text actually sits — below WCAG AA, and the
      // mistake a single-token check makes. So the probe composites the ancestor chain (alpha
      // bottom-up, stopping at the first opaque layer) rather than trusting one token. The audited
      // failure was an accent used as TEXT at ~1.025:1.
      //
      // Each selector is measured separately and each must MATCH something: a ratio list that came
      // back empty would pass a "> 0" check on a different element while reporting nothing about the
      // surface it was supposed to cover (§4.1 — "not measured" is not "zero").
      //
      // A real function, not a source string: `page.evaluate` with a string expression does not
      // forward the argument, and the first run of this test died on `ratios.length` of `undefined`.
      // The probe is self-contained (DOM + getComputedStyle only), so it serializes cleanly.
      const probe = (selector: string) => {
        const srgb = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const lum = (rgb: number[]) =>
          0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);
        const parse = (value: string) => {
          const m = /rgba?\(([^)]+)\)/.exec(value);
          if (!m) return null;
          const n = m[1].split(',').map((x) => Number.parseFloat(x));
          return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
        };
        // Composite the ancestor chain alpha bottom-up, stopping at the first opaque layer: the
        // panel's background is translucent, so the token alone is not the colour the text sits on.
        const behind = (el: Element): number[] => {
          const stack: { rgb: number[]; a: number }[] = [];
          for (let node: Element | null = el; node; node = node.parentElement) {
            const c = parse(getComputedStyle(node).backgroundColor);
            if (c && c.a > 0) {
              stack.push(c);
              if (c.a >= 1) break;
            }
          }
          if (!stack.length) return [255, 255, 255];
          let acc = stack.pop()!.rgb.slice();
          while (stack.length) {
            const c = stack.pop()!;
            acc = [0, 1, 2].map((i) => acc[i] * (1 - c.a) + c.rgb[i] * c.a);
          }
          return acc;
        };
        return [...document.querySelectorAll(selector)]
          .filter((el) => (el.textContent || '').trim() && el.getBoundingClientRect().width > 0)
          .map((el) => {
            const fg = parse(getComputedStyle(el).color);
            const bg = behind(el);
            const l1 = lum(fg ? fg.rgb : [255, 255, 255]);
            const l2 = lum(bg);
            return {
              text: (el.textContent || '').trim().slice(0, 44),
              ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
            };
          });
      };
      const contrast = async (theme: string, selectors: string[]) => {
        for (const selector of selectors) {
          const ratios = (await page.evaluate(probe, selector)) as {
            text: string;
            ratio: number;
          }[];
          expect(ratios.length, `${theme} theme — nothing matched ${selector}`).toBeGreaterThan(0);
          // Recorded on the report so the R08 claim carries numbers rather than only a verdict.
          // Purely additive — it cannot change what is asserted.
          const floor = Math.min(...ratios.map((r) => r.ratio));
          test.info().annotations.push({
            type: `contrast/${theme}`,
            description: `${selector} → floor ${floor.toFixed(2)}:1 over ${ratios.length} element(s)`,
          });
          for (const r of ratios) {
            expect(
              r.ratio,
              `${theme} theme — "${r.text}" measured ${r.ratio.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      };
      // The two spans this work package added, plus the §7.4 recovery line — the tile's own repair
      // text, which sits on the same chip surface.
      const LIST_SURFACES = [
        '[data-kc-mem-excluded] > span',
        '[data-kc-mem-reason]',
        '[data-kc-mem-recovery]',
      ];
      const DETAIL_SURFACES = [
        '[data-kc-mem-detail-excluded] > span',
        '[data-kc-mem-detail-reason]',
        '[data-kc-mem-recovery]',
      ];
      // The theme toggle carries no data attribute; it is located by its title.
      const toggleTheme = () => page.locator('button[title="Toggle theme"]').click();

      await contrast('dark', LIST_SURFACES);
      await toggleTheme();
      await contrast('light', LIST_SURFACES); // the theme the audit measured

      // Enter on the row opens the record. `press` focuses the row and presses the key, so this is
      // still a keyboard activation — the toggle above moved focus off the row, and re-tabbing to it
      // would assert nothing the traversal loop has not already asserted.
      // The detail is the second surface §7.4 added, so it is reached the same way and measured the
      // same way.
      await page.locator(`[data-kc-mem-row="${backend.driftedId}"]`).press('Enter');
      await expect(page.locator('[data-kc-mem-detail-back]')).toBeFocused();
      await expect(page.locator('[data-kc-mem-detail-excluded="evidence"]')).toBeVisible();

      await contrast('light', DETAIL_SURFACES);
      await toggleTheme();
      await contrast('dark', DETAIL_SURFACES);
    });
  });
