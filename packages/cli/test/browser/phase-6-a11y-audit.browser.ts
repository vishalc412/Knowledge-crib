import { appendFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { type AxeFinding, runAxe } from './axe.js';
import { MemoryBackend } from './backend.js';
import { sampleTextContrast, undersizedTargets } from './contrast.js';

// Phase 6 — the automated half of the release accessibility gate. Every UI state reachable today
// is driven through the REAL backend, in both themes, at desktop and phone widths, and checked with
// axe-core's WCAG 2.2 A/AA rules plus this suite's composited-contrast and target-size samplers.
// Automated checks SUPPORT the independent assessment; they never replace it (see
// docs/audits/2026-09-23/phase-6-accessibility-gate.md). Set A11Y_REPORT=<file> to write the raw
// findings for the issue log
// (one JSON line per state: a failed test restarts the worker, so nothing is held in memory).
let backend: MemoryBackend;

test.beforeAll(async () => {
  backend = new MemoryBackend({ evidenceKinds: true, reviewClaims: 3 });
  await backend.start();
});

test.afterAll(async () => {
  await backend.dispose();
});

/**
 * Canvas selection needs a pointer (no keyboard path reaches a node until the deferred Phase 3 List
 * view exists — logged as A11Y-001). A small fixed graph makes the single match land at a known
 * point so the inspector DOM itself can be audited.
 */
async function routeSmallGraph(page: Page) {
  const names = ['RootAnchor', 'CalledHelper', 'CallerA', 'Documented'];
  const nodes = names.map((id, i) => ({
    id,
    label: id,
    kind: i === 3 ? 'doc-section' : 'function',
    importance: names.length - i,
    tier: 'primary',
    qualified: `demo.${id}`,
    file: 'src/index.ts',
    span: { start: 2, end: 4 },
    summary: `${id} is part of the audit fixture.`,
  }));
  const edges = [
    { src: 'RootAnchor', dst: 'CalledHelper', rel: 'calls' },
    { src: 'CallerA', dst: 'RootAnchor', rel: 'calls' },
    { src: 'Documented', dst: 'RootAnchor', rel: 'describes' },
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
}

async function selectSearchedNode(page: Page) {
  // Phones open in List (Phase 3); the canvas path is audited in the Graph presentation.
  const graph = page.locator('[data-kc-presentation="graph"]');
  if ((await graph.getAttribute('aria-pressed')) !== 'true') await graph.click();
  await page.getByPlaceholder('Search code, docs, tables…').fill('RootAnchor');
  await expect(page.locator('[data-kc-search-status]')).toContainText('match');
  const stage = page.locator('[data-kc-graph-stage]');
  const box = (await stage.boundingBox())!;
  const zoom =
    Number(
      (await page.locator('[data-kc-stage-zoom] button').nth(1).innerText()).replace('%', ''),
    ) / 100;
  // Search centres its best match at world (0,0); the fit offsets the camera 20 world units.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 20 * zoom);
  await expect(page.locator('[data-kc-inspector-heading]')).toBeVisible();
}

async function openMemory(page: Page, tile?: string) {
  await page.locator('[data-kc-memory-trigger]').click();
  await expect(page.locator('[data-kc-memory-home-action="active"]')).toBeVisible({
    timeout: 20_000,
  });
  if (tile) await page.locator(`[data-kc-memory-home-action="${tile}"]`).click();
}

async function openEvidenceDetail(page: Page) {
  await openMemory(page, 'history');
  await page.locator(`[data-kc-mem-row="${backend.evidenceRecordId}"]`).click();
  await expect(page.locator('[data-kc-mem-evidence-item]')).toHaveCount(6, { timeout: 20_000 });
}

interface AuditState {
  name: string;
  mobile?: boolean;
  /** 1440 px: the widest audited layout, where Split is offered. */
  wide?: boolean;
  /** runs before navigation (network fixtures). */
  setup?(page: Page): Promise<void>;
  go(page: Page): Promise<void>;
}

const STATES: AuditState[] = [
  { name: 'overview', go: async () => {} },
  {
    name: 'search-results',
    go: async (page) => {
      await page.getByPlaceholder('Search code, docs, tables…').fill('normalize');
      await expect(page.locator('[data-kc-search-status]')).toBeVisible();
    },
  },
  {
    name: 'search-no-results',
    go: async (page) => {
      await page.getByPlaceholder('Search code, docs, tables…').fill('no-such-symbol-2026');
      await expect(page.locator('[data-kc-search-status]')).toBeVisible();
    },
  },
  { name: 'node-inspector', setup: routeSmallGraph, go: selectSearchedNode },
  {
    name: 'node-blast',
    setup: routeSmallGraph,
    go: async (page) => {
      await selectSearchedNode(page);
      await page.locator('[data-kc-command="blast"]').click();
    },
  },
  {
    name: 'help',
    go: async (page) => {
      await page.locator('[data-kc-help-trigger]').click();
      await expect(page.locator('[data-kc-help]')).toBeVisible();
    },
  },
  {
    name: 'inspector-empty',
    go: async (page) => {
      await page.locator('[data-kc-inspector-toggle]').click();
    },
  },
  { name: 'memory-home', go: (page) => openMemory(page) },
  { name: 'memory-active', go: (page) => openMemory(page, 'active') },
  { name: 'memory-needs-review', go: (page) => openMemory(page, 'needsReview') },
  { name: 'memory-history', go: (page) => openMemory(page, 'history') },
  {
    name: 'memory-pending',
    go: async (page) => {
      await openMemory(page, 'pending');
      await expect(page.locator('[data-kc-mem-action-head]')).toBeVisible();
    },
  },
  {
    name: 'memory-resume-detail',
    go: async (page) => {
      await openMemory(page, 'resume');
      await page.locator('[data-kc-mem-choice]').first().click();
      await expect(page.getByText('Checkpoint history')).toBeVisible();
    },
  },
  { name: 'memory-record-detail', go: openEvidenceDetail },
  {
    name: 'memory-evidence-open',
    go: async (page) => {
      await openEvidenceDetail(page);
      for (const index of [0, 1, 2, 5]) {
        await page.locator(`[data-kc-mem-evidence-inspect="${index}"]`).click();
      }
      await expect(page.locator('[data-kc-mem-evidence-panel] dl')).toHaveCount(4);
    },
  },
  {
    name: 'memory-concern-form',
    go: async (page) => {
      await openEvidenceDetail(page);
      await page.locator('[data-kc-mem-concern-open]').click();
      await page.locator('[data-kc-mem-concern-submit]').click();
      await expect(page.locator('[data-kc-mem-concern-error]')).toBeVisible();
    },
  },
  // Phase 3 — the textual explorer (List, Split, Blast table) and its recovery states.
  {
    name: 'list-overview',
    go: async (page) => {
      await page.locator('[data-kc-presentation="list"]').click();
      await expect(page.locator('[data-kc-result-row]').first()).toBeVisible();
    },
  },
  {
    name: 'list-search',
    go: async (page) => {
      await page.locator('[data-kc-presentation="list"]').click();
      await page.getByPlaceholder('Search code, docs, tables…').fill('normalize');
      await expect(page.locator('[data-kc-result-row]').first()).toBeVisible();
    },
  },
  {
    name: 'list-zero-results',
    go: async (page) => {
      await page.locator('[data-kc-presentation="list"]').click();
      await page.getByPlaceholder('Search code, docs, tables…').fill('no-such-symbol-2026');
      await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
    },
  },
  {
    name: 'list-focus-and-blast',
    setup: routeSmallGraph,
    go: async (page) => {
      await page.locator('[data-kc-presentation="list"]').click();
      await page.getByPlaceholder('Search code, docs, tables…').fill('RootAnchor');
      await page.locator('[data-kc-result-row] button').first().click();
      await page.locator('[data-kc-command="blast"]').click();
      await expect(page.getByRole('table', { name: 'Blast results' })).toBeVisible();
    },
  },
  {
    name: 'split',
    wide: true,
    go: async (page) => {
      await page.locator('[data-kc-presentation="split"]').click();
      await expect(page.locator('[data-kc-result-row]').first()).toBeVisible();
    },
  },
  {
    name: 'graph-load-failure',
    setup: async (page) => {
      await page.route('**/graph.json', (route) => route.fulfill({ status: 503, body: 'down' }));
    },
    go: async (page) => {
      await expect(page.getByRole('alert').first()).toBeVisible();
    },
  },
  // Phase 5 — health signals and failure/retry states.
  {
    name: 'memory-load-failure',
    setup: async (page) => {
      await page.route('**/memory.json?*', (route) => route.fulfill({ status: 503, body: 'down' }));
    },
    go: async (page) => {
      await page.locator('[data-kc-memory-trigger]').click();
      await expect(page.getByRole('button', { name: 'Retry Memory' })).toBeVisible();
    },
  },
  {
    name: 'memory-detail-failure',
    setup: async (page) => {
      await page.route('**/memory/record.json?*', (route) =>
        route.fulfill({ status: 503, body: 'down' }),
      );
    },
    go: async (page) => {
      await openMemory(page, 'history');
      await page.locator('[data-kc-mem-row]').first().click();
      await expect(page.locator('[data-kc-detail-error]')).toBeVisible();
    },
  },
  { name: 'mobile-overview', mobile: true, go: async () => {} },
  {
    name: 'mobile-drawer',
    mobile: true,
    go: async (page) => {
      await page.locator('[data-kc-rail-toggle]').click();
    },
  },
  { name: 'mobile-inspector', mobile: true, setup: routeSmallGraph, go: selectSearchedNode },
  { name: 'mobile-memory-detail', mobile: true, go: openEvidenceDetail },
];

for (const scheme of ['dark', 'light'] as const) {
  for (const state of STATES) {
    test(`${state.name} (${scheme}) has no WCAG 2.2 A/AA automated failures`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize(
        state.mobile
          ? { width: 375, height: 812 }
          : state.wide
            ? { width: 1440, height: 900 }
            : { width: 1280, height: 900 },
      );
      if (state.setup) await state.setup(page);
      await page.goto(backend.url);
      await expect(page.locator('[data-kc-shell]')).toHaveAttribute('data-kc-theme', scheme);
      await state.go(page);
      await page.waitForTimeout(250); // let entry animations and focus settle
      const axe: AxeFinding[] = await runAxe(page, '[data-kc-shell]');
      const contrast = await sampleTextContrast(page, '[data-kc-shell]');
      const targets = await undersizedTargets(page, '[data-kc-shell]', state.mobile ? 44 : 24);
      if (process.env.A11Y_REPORT) {
        const line = { state: `${state.name}/${scheme}`, axe, contrast, targets };
        appendFileSync(process.env.A11Y_REPORT, `${JSON.stringify(line)}\n`);
      }
      expect.soft(axe, 'axe WCAG A/AA violations').toEqual([]);
      expect.soft(contrast, 'text contrast below AA').toEqual([]);
      expect.soft(targets, 'targets below the WCAG 2.5.8 minimum').toEqual([]);
    });
  }
}
