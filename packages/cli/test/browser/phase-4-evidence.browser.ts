import { type Page, expect, test } from '@playwright/test';
import { EVIDENCE_SENTINEL, MemoryBackend } from './backend.js';
import { sampleTextContrast } from './contrast.js';

// Phase 4 — a reviewer can inspect the basis of every evidence kind in one action (or is told
// exactly why not), and can report a concern that is recorded for review without changing the
// claim's lifecycle. Serial: the concern test mutates the backend the later tests read.
let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend({ evidenceKinds: true });
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

async function openEvidenceClaim(page: Page) {
  await page.goto(backend.url);
  await page.locator('[data-kc-memory-trigger]').click();
  await page.locator('[data-kc-memory-home-action="history"]').click();
  const row = page.locator(`[data-kc-mem-row="${backend.evidenceRecordId}"]`);
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
  await expect(page.locator('[data-kc-mem-evidence-item]')).toHaveCount(6, { timeout: 20_000 });
}

async function inspect(page: Page, index: number) {
  const button = page.locator(`[data-kc-mem-evidence-inspect="${index}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const item = page.locator(`[data-kc-mem-evidence-item="${index}"]`);
  await expect(item.locator('[data-kc-mem-evidence-panel] dl')).toBeVisible();
  return item;
}

test.describe
  .serial('evidence inspection and concern reporting', () => {
    test('the claim, its verdicts and scope come before technical identifiers', async ({
      page,
    }) => {
      await openEvidenceClaim(page);
      const claim = page.locator('[data-kc-mem-claim]');
      const technical = page.locator('[data-kc-mem-technical]');
      await expect(claim).toBeVisible();
      await expect(technical).not.toHaveAttribute('open');
      const order = await page.evaluate(() => {
        const a = document.querySelector('[data-kc-mem-claim]')!;
        const b = document.querySelector('[data-kc-mem-technical]')!;
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
      });
      expect(order).toBeTruthy();
      await technical.locator('summary').click();
      await expect(page.locator('[data-kc-mem-cli]')).toContainText(
        `crib memory supersede ${backend.evidenceRecordId}`,
      );
    });

    test('a current source quote shows the saved quote beside the live excerpt', async ({
      page,
    }) => {
      await openEvidenceClaim(page);
      const item = await inspect(page, 0);
      await expect(item).toContainText('Source quote');
      await expect(item).toContainText('(as recorded, not necessarily current)');
      await expect(item).toContainText('current at src/index.ts');
      await expect(item.locator('[data-kc-mem-evidence-excerpt]')).toContainText(
        'export function normalizeInput',
      );
    });

    test('a vanished source keeps the saved quote and says it is no longer current', async ({
      page,
    }) => {
      await openEvidenceClaim(page);
      const item = await inspect(page, 1);
      await expect(item).toContainText('a function that was deleted');
      await expect(item).toContainText('no longer in the index');
      await expect(item.locator('[data-kc-mem-evidence-unavailable]')).toContainText(
        'only the saved record remains',
      );
      await expect(item.locator('[data-kc-mem-evidence-excerpt]')).toHaveCount(0);
    });

    test('execution, policy, attestation and receipt-pair evidence each explain themselves', async ({
      page,
    }) => {
      await openEvidenceClaim(page);
      const execution = await inspect(page, 2);
      await expect(execution).toContainText('exit-ok');
      await expect(execution).toContainText('passed');
      await expect(execution).toContainText('blake3:dd44');
      await expect(execution).toContainText('the raw output was never stored');

      const policy = await inspect(page, 3);
      await expect(policy).toContainText('art:docs/policy.md');
      await expect(policy.locator('[data-kc-mem-evidence-unavailable]')).toBeVisible();

      const attestation = await inspect(page, 4);
      await expect(attestation).toContainText('human:reviewer');
      await expect(attestation).toContainText('not an independent check of the code');

      const pair = await inspect(page, 5);
      await expect(pair).toContainText('exit 1');
      await expect(pair).toContainText('missing (rcpt:0a0a)');
      await expect(pair).toContainText('cannot be determined while a receipt is missing');

      // The redaction boundary holds in the rendered page, not just in the API.
      await expect(page.locator('[data-kc-memory-panel]')).not.toContainText(EVIDENCE_SENTINEL);
    });

    test('the evidence API is display-safe and answers one 404 for anything unavailable', async () => {
      const ok = await fetch(
        `${backend.url}/memory/evidence.json?recordId=${encodeURIComponent(backend.evidenceRecordId)}&index=5`,
      );
      expect(ok.status).toBe(200);
      const text = await ok.text();
      expect(text).not.toContain(EVIDENCE_SENTINEL);
      expect(text).not.toContain('"args"');
      expect(text).not.toContain('"meta"');
      for (const query of [
        `recordId=${encodeURIComponent(backend.evidenceRecordId)}&index=6`,
        'recordId=mem:missing&index=0',
      ]) {
        const res = await fetch(`${backend.url}/memory/evidence.json?${query}`);
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('evidence not found');
      }
      for (const query of [
        'recordId=x&index=-1',
        'recordId=x&index=a',
        'index=0',
        'recordId=x&index=0&path=../../etc/passwd',
      ]) {
        const res = await fetch(`${backend.url}/memory/evidence.json?${query}`);
        expect([400, 404]).toContain(res.status);
      }
    });

    test('the concern route refuses a missing Origin, a foreign Origin and a missing token', async () => {
      const body = JSON.stringify({ recordId: backend.evidenceRecordId, reason: 'probe' });
      const noOrigin = await fetch(`${backend.url}/memory/feedback`, { method: 'POST', body });
      expect(noOrigin.status).toBeGreaterThanOrEqual(400);
      const foreign = await fetch(`${backend.url}/memory/feedback`, {
        method: 'POST',
        body,
        headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      });
      expect(foreign.status).toBe(403);
      const noToken = await fetch(`${backend.url}/memory/feedback`, {
        method: 'POST',
        body,
        headers: { origin: backend.url, 'content-type': 'application/json' },
      });
      expect(noToken.status).toBe(403);
    });

    test('reporting a concern records feedback for review without changing the claim', async ({
      page,
    }) => {
      await openEvidenceClaim(page);
      const before = (await backend.getJson('/memory.json?view=active&limit=200')) as {
        rows: { id: string }[];
      };
      expect(before.rows.some((r) => r.id === backend.evidenceRecordId)).toBe(true);

      await page.locator('[data-kc-mem-concern-open]').click();
      await expect(page.locator('[data-kc-mem-concern-reason]')).toBeFocused();
      await expect(page.locator('[data-kc-mem-concern]')).toContainText(
        'does not retract, quarantine or supersede',
      );
      // A blank reason is refused in the browser before anything is sent.
      await page.locator('[data-kc-mem-concern-submit]').click();
      await expect(page.locator('[data-kc-mem-concern-error]')).toContainText('Describe');

      await page.locator('[data-kc-mem-concern-reason]').fill('The hashing moved to a helper.');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-kc-mem-concern-notice]')).toHaveText(
        'Recorded for review; this does not automatically retract or quarantine the claim.',
      );
      await expect(page.locator('[data-kc-mem-concerns]')).toContainText(
        'The hashing moved to a helper.',
      );

      // Still active and recall-eligible; now also listed in Needs review with the concern.
      const review = (await backend.getJson('/memory.json?view=needs-review&limit=200')) as {
        rows: {
          id: string;
          eligible: boolean;
          quarantined: boolean;
          reviewReasons: { code: string }[];
        }[];
      };
      const row = review.rows.find((r) => r.id === backend.evidenceRecordId);
      expect(row?.reviewReasons.map((r) => r.code)).toContain('concern');
      expect(row?.eligible).toBe(true);
      expect(row?.quarantined).toBe(false);

      // Back returns to History, refreshed.
      await page.locator('[data-kc-mem-detail-back]').click();
      await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
      await expect(page.locator(`[data-kc-mem-row="${backend.evidenceRecordId}"]`)).toBeFocused();
    });

    test('a repeated identical report is idempotent', async ({ page }) => {
      await page.goto(backend.url);
      const token = ((await backend.getJson('/memory/mutation-grant.json')) as { token: string })
        .token;
      const post = () =>
        fetch(`${backend.url}/memory/feedback`, {
          method: 'POST',
          headers: {
            origin: backend.url,
            'content-type': 'application/json',
            'x-crib-csrf': token,
          },
          body: JSON.stringify({
            recordId: backend.evidenceRecordId,
            reason: 'The hashing moved to a helper.',
          }),
        }).then((r) => r.json() as Promise<{ feedbackId: string; quarantined: boolean }>);
      const first = await post();
      const second = await post();
      expect(second.feedbackId).toBe(first.feedbackId);
      expect(second.quarantined).toBe(false);
    });

    for (const scheme of ['dark', 'light'] as const) {
      test(`inspected evidence stays readable in ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openEvidenceClaim(page);
        await inspect(page, 0);
        await inspect(page, 5);
        expect(await sampleTextContrast(page, '[data-kc-memory-panel]')).toEqual([]);
      });
    }
  });
