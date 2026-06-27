# Large Project Viz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `crib viz` usable for large projects by opening on a readable architecture overview and drilling into focused graph slices.

**Architecture:** Keep the existing static DC runtime page. Add client-side derived overview data from the already-loaded `graph.json`, a mode switch, overview drawing/hit-testing, and focused filtering for node-level rendering.

**Tech Stack:** Static HTML/JS DC runtime, Canvas 2D, Vitest static regression tests.

---

### Task 1: Pin Overview Contract

**Files:**
- Modify: `packages/cli/src/viz.test.ts`

- [ ] Add a failing test that reads `vizAssetsDir()/index.html` and expects the strings `overview`, `buildOverview`, `drawOverview`, and `visibleNodes`.
- [ ] Run `./node_modules/.bin/vitest run src/viz.test.ts --reporter=dot` from `packages/cli`.
- [ ] Confirm the test fails because overview behavior is missing.

### Task 2: Add Overview State And Data

**Files:**
- Modify: `packages/ui/web/index.html`

- [ ] Add `mode`, `selectedClusterId`, and overview arrays/maps to component state.
- [ ] Build cluster summaries after nodes and edges load.
- [ ] Sort clusters by member count and degree signal.
- [ ] Limit overview blocks to a presentable top set with an overflow summary.

### Task 3: Render Overview And Focus

**Files:**
- Modify: `packages/ui/web/index.html`

- [ ] Make large graphs default to Overview mode.
- [ ] Draw overview blocks and high-signal inter-cluster links.
- [ ] Draw node-level graph only for Focus mode or small graphs.
- [ ] Restrict Focus mode to selected cluster, selected node neighborhood, or search results.

### Task 4: Interactions

**Files:**
- Modify: `packages/ui/web/index.html`

- [ ] Add Overview/Focus toggle controls in the top bar.
- [ ] Let clicking an overview block select that cluster and enter Focus.
- [ ] Keep existing node click, tooltip, search, blast radius, and keyboard behavior working for visible nodes.

### Task 5: Verify

**Files:**
- Modify: `packages/cli/src/viz.test.ts`
- Modify: `packages/ui/web/index.html`

- [ ] Run `./node_modules/.bin/vitest run src/viz.test.ts --reporter=dot` from `packages/cli`.
- [ ] Start or refresh `crib viz` and confirm large-project view is no longer a full-screen mesh.
