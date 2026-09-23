# Phase 1 — theme, document semantics, and responsive shell

Branch `claude/ui-remediation-phase-1`, based on the Phase 0 commit `eef84d7f`. Audit coverage: mobile rail, light contrast, document metadata, mobile inspector, theme persistence, and the design-system foundation.

## Starting point

A previous session had begun Phase 1 in a separate worktree and left it uncommitted: `tokens.css`, the `.css` MIME entry, template markup for the drawer/inspector/help roles, and `phase-1-shell.browser.ts`. That work was copied into this branch unchanged as the starting point. The component logic its markup referred to (`theme`, `railRole`, `openRail`, `searchShortcut`, `themeToggleLabel` and others) did not exist yet. This phase adds it.

## What changed

**Tokens.** `packages/ui/web/tokens.css` is a local stylesheet, linked relatively and served as `text/css`. It defines semantic tokens for surfaces, text, interactive text, focus, control borders, separators, code, canvas, selection, and accents, in matching dark and light sets (the unit test enforces parity). Its header records the measured contrast pairings. The template's `t.*` chrome values now resolve to these tokens rather than per-theme literals, so each existing template reference follows the active theme. The canvas cannot read CSS, so it caches `--kc-canvas-*` from the computed style once per theme change.

**Theme.** Precedence: an explicit component prop, then the `knowledge-crib:theme` storage value (only `light` or `dark` are accepted), then `prefers-color-scheme`. Storage reads and writes are guarded, so blocked or missing storage falls back to the system theme and the toggle still works for the session. With no explicit choice, the page follows live system changes. The toggle's accessible name describes the action, for example “Switch to light theme.”

**Document semantics.** `<html lang="en">`, a descriptive `<title>`, one `<h1>Knowledge graph</h1>` that remains in the accessibility tree when the brand collapses, and ordered `h2`/`h3` headings for navigation, inspector, help, and Memory home. The visible label “Search graph” is attached to the search field. The shortcut hint shows ⌘K on Apple platforms and Ctrl K elsewhere.

**Responsive shell.** At 760 px and narrower, the rail toggle opens an opaque, full-height, scrollable navigation drawer with a scrim, a labelled heading, `aria-expanded`, a visible close control, Escape, focus entry to the heading, and focus return to the invoking control. The overview “+N more modules” control opens the same drawer. Choosing a module closes it. Widening past the breakpoint closes the drawer without discarding the desktop rail preference. The mobile inspector is an opaque full-screen dialog.

**Modal layers and focus.** One rule decides which layer owns the keyboard: Memory, then the mobile drawer, then the mobile inspector. Every other shell layer is made `inert` imperatively, so React never overwrites the attribute. While Memory is open, its own trigger stays operable so pointer users can close it the way they opened it. The trigger now exposes `aria-expanded`. Opening the inspector with the keyboard moves focus to its heading; opening it with a pointer does not move focus. On close, focus returns to the invoking control when it is still usable, and otherwise to the inspector toggle. Help is a non-modal popover dialog: opening it focuses its close button, and Escape returns focus to the Help button.

**Type, targets, and fonts.** No template text is smaller than 12 px, and body copy is 14 px. Desktop controls are at least 32 × 32 px, and touch layouts (760 px and narrower) at least 44 × 44 px. Every font shorthand now carries a system fallback stack. Previously, 63 declarations named only IBM Plex, which is not bundled, so rail headings, stats, inspector copy, and the status line rendered in a serif default offline.

**Contrast fixes found by measurement.** The selected view segment was white on `#5b8cff` (3.16:1) and is now on `--kc-selected-surface` (5.2:1). The segment exposes `aria-pressed`. Node-type rows used row-level `opacity` for de-emphasized kinds, pulling their text to 2.3–3.3:1. Only the swatch dims now, and hidden kinds are shown with strike-through and `aria-pressed="false"`. The Memory badge and the Memory home accent use theme text tokens.

## Verification

| Gate | Result |
| --- | --- |
| `phase-1-shell.browser.ts` | 18/18: token sheet served as CSS; system-then-stored theme; invalid and blocked storage; storage key and toggle label; canvas corner pixel equals the page token in both themes; contrast and target sizes at 1280 and 375 px in both themes, closed and with the inspector or drawer open; heading outline; platform shortcut; 320 × 256 (400 % zoom) reflow with the drawer reachable; keyboard vs pointer inspector focus; Memory focus containment; breakpoint widening |
| Phase 0 acceptance cases | The four Phase 1 cases (two mobile navigation widths, light contrast, document semantics) now pass without `test.fail`. The Phase 2 and 3 cases remain expected failures |
| Full browser suite | 42/42 (39 passing plus 3 remaining expected failures) |
| UI unit | 37/37 |
| CLI unit (bounded, `--maxWorkers=2`, as established in Phase 0) | 599/599 across 41 files |
| Typecheck, Biome on changed paths | Passed |
| Offline package check | 8/8 tarballs; `tokens.css` ships inside `packages/ui/web` |

Contrast is sampled by compositing each text run's ancestors' backgrounds and opacity onto the page surface (`packages/cli/test/browser/contrast.ts`). This supports, and does not replace, the manual and assistive-technology assessment in Phase 6.

## Documented exceptions and known limits

- Memory panel internals (tiles, pending rows, and detail chips) still use literal accent colours on tinted chips. They belong to Phases 2 and 5, which rebuild those views; the Phase 1 contrast sampling covers the shell, rail, stage chrome, inspector, and Help.
- The canvas's own labels and node colours are drawn pixels, not DOM text, so they fall outside the text-contrast sampler. The textual List presentation in Phase 3 is the accessible equivalent.
- The large-graph benchmark was not rerun for this phase. Phase 1 adds no per-frame work: modal-layer and focus synchronization run once per React update, never in the draw loop. Phase 3 will compare against the Phase 0 baseline.
