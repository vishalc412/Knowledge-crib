# Knowledge Grid Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an accessible Signal Console design system for the Knowledge Grid without changing its local-only data or memory contracts.

**Architecture:** Keep `packages/ui/web/index.html` as the static offline UI boundary and evolve its existing DC component. Introduce semantic tokens and shell layout in that asset; protect the user-visible contract with the existing static-asset test and validate interaction through browser coverage.

**Tech Stack:** Static HTML, CSS custom properties, DC runtime, vendored React, Vitest, Playwright.

---

## File map

- `packages/ui/web/index.html` — visual tokens, responsive app shell, graph composition, and component state.
- `packages/ui/src/web-assets.test.ts` — static contract for design-system accessibility and shell structure.
- `packages/cli/test/browser/memory-graph.browser.ts` — end-to-end graph browser behavior.

### Task 1: Pin the design-system contract

**Files:**
- Modify: `packages/ui/src/web-assets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('ships the Signal Console shell and accessible motion rules', () => {
  expect(html).toContain('data-kc-shell="signal-console"');
  expect(html).toContain('data-kc-navigation-rail');
  expect(html).toContain('data-kc-graph-stage');
  expect(html).toContain('data-kc-inspector');
  expect(html).toContain('--kc-accent-code');
  expect(html).toContain('@media (prefers-reduced-motion: reduce)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @knowledge-crib/ui test -- web-assets.test.ts`

Expected: FAIL because the static asset has no Signal Console shell contract.

- [ ] **Step 3: Implement the minimal static contract**

Add the named data attributes, semantic tokens, and reduced-motion media query to `packages/ui/web/index.html`, without removing existing `data-kc-*` memory hooks.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @knowledge-crib/ui test -- web-assets.test.ts`

Expected: PASS.

### Task 2: Build the desktop Signal Console layout

**Files:**
- Modify: `packages/ui/web/index.html`

- [ ] **Step 1: Add the shell geometry**

Replace the single full-window canvas composition with a grid of command bar, navigation rail, graph stage, inspector, and status line. Keep every action connected to the existing component methods.

- [ ] **Step 2: Add semantic token mapping**

Map dark and light themes into `--kc-*` semantic custom properties. Use semantic code, documentation, review, and risk accents in the canvas, pills, and selected-node chrome.

- [ ] **Step 3: Make information layers controllable**

Add a rail-collapse state and bind it to the existing module/filter data. Keep stage breadcrumbs, fit controls, and inspector actions visible without obscuring the graph.

- [ ] **Step 4: Add responsive behavior**

Use 1100px and 760px breakpoints to collapse secondary controls, overlay the inspector, and retain access to Memory, search, modules, and filters. Add the reduced-motion rule defined in Task 1.

### Task 3: Verify user workflows

**Files:**
- Test: `packages/ui/src/web-assets.test.ts`
- Test: `packages/cli/test/browser/memory-graph.browser.ts`

- [ ] **Step 1: Run the focused static asset suite**

Run: `pnpm --filter @knowledge-crib/ui test -- web-assets.test.ts`

Expected: all static asset contracts pass.

- [ ] **Step 2: Run the UI package suite and typecheck**

Run: `pnpm --filter @knowledge-crib/ui test && pnpm --filter @knowledge-crib/ui typecheck`

Expected: both commands exit 0.

- [ ] **Step 3: Run browser verification**

Run: `pnpm --filter @knowledge-crib/cli exec playwright test test/browser/memory-graph.browser.ts`

Expected: graph selection, memory navigation, and keyboard access remain functional.

- [ ] **Step 4: Inspect the rendered desktop layout**

Run the local visualization and capture a desktop viewport. Confirm the rail, stage, inspector, Memory trigger, and selected-node actions are visible at once.
