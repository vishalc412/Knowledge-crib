# UI remediation audit — all six phases against the plan

Audited 2026-09-24 on branch `claude/ui-remediation-audit`. This was a requirement-by-requirement check of the UI remediation plan (Phases 0–6) against the **integrated** product. Each finding records the evidence that decided it: a test, a probe, a measurement, or a code reading. Where a requirement was not met, it was fixed on this branch and the fix was verified. Requirements that need people outside the team stay open and are named as such.

Legend: **Met**; **Met — fixed in audit** (not met at audit start, fixed and verified here); **Open — external** (needs someone outside the implementation team).

## Headline findings

1. **The six phases were never one product.** They shipped as two parallel stacks from Phase 0: `0 → 1 → 2 → 4 → 6` (#64 #65 #67 #68 #70) and `0 → 3 → 5` (#69 #71). Nothing was merged, so no tree contained every phase, and each stack's tests ran without the other's features. Merging them produced 20 conflict hunks, 15 of them in `index.html`. Before resolution, eight browser specs failed where the stacks met. Merge commit `84d3765e` integrates them and repairs those seams.
2. **Phase 5's token migration was incomplete, as its own design doc stated.** The accent tokens were used zero times, 47 status tints and borders, plus 6 hover, selected and scrollbar colours, were literal `rgba(…)`, and the canvas palette existed twice. Fixed.
3. **Phase 5's required test matrix did not exist.** There were no tests at 768 or 1440 px, no long or multilingual content, no hover/selected/error contrast, and no stale or partial fixtures. Written here. It found one real defect (item 5 below).
4. **Two Phase 5 async-state gaps.** The source-preview failure had no alert and no recovery, and neither evidence inspection nor the Memory home offered Retry. Fixed.
5. **One Phase 3 defect.** An *empty* code index showed a phantom "Project" result instead of the empty-index state. Fixed in the pure projection, with a unit test.
6. **The benchmark comparison was quantized to one animation frame.** An apparent +13% search regression was frame polling. A precise in-page A/B against Phase 0 on the same machine shows search −5.4% and startup −1.6%. The benchmark now measures this way.
7. **Two plan gates cannot be closed by the implementation team:** the independent WCAG 2.2 AA assessment, and the human task study. `pnpm run ui:gate` reports **UNAVAILABLE** (not FAIL). No Level A or AA issue is open.

## Cross-cutting decisions

| Requirement | Status | Evidence |
| --- | --- | --- |
| Graph, List and Split; desktop starts in Graph, below 760 px in List; Split from 1280 px | Met | `phase-3-explorer.browser.ts` mobile and Split cases; `effectivePresentation()` |
| Active is recall-eligible; Needs review includes excluded and degraded claims; the overlap is explained | Met | `ledger.test.ts` working-view cases; overlap note on the home tiles |
| Inspect all five evidence kinds with safe detail | Met | `evidence-inspection.test.ts`; `phase-4-evidence.browser.ts` |
| Report a concern without quarantining, retracting or superseding | Met | `phase-4-evidence.browser.ts` (eligible, not quarantined, idempotent) |
| Independent product-wide WCAG 2.2 AA assessment and sign-off | **Open — external** | Assessor brief, issue log and draft report ready; the gate refuses self-assessment |
| Separate PRs per phase, in order | Met, with a caveat | Every phase has its PR, but the stacks diverged (headline 1). Merge order below |

## Explorer and APIs

| Requirement | Status | Evidence |
| --- | --- | --- |
| One selection, query, filter and page state drives all three presentations | Met | Split synchronization and filter-survival cases |
| List pages ≤50 rows; the full repository is never in the DOM | Met | `paginate()` caps at 50; benchmark peak 50 rows on 49,096 nodes |
| Canvas caps and truncation stated beside results, never "all affected" | Met | Projection `graphNote`; "discovered affected nodes" |
| `GET /memory.json?view=` with 400s, additive `views` and `reviewReasons`, counted before paging | Met | `viz-server.test.ts`; `phase-2-memory.browser.ts` (230 claims, every page) |
| Tile count equals the destination total; Back returns to the view and page | Met | `phase-2-memory.browser.ts` |
| `GET /memory/evidence.json` with no client paths; one 404; redaction | Met | `viz-server.test.ts`; sentinel tests in unit and browser specs |
| `POST /memory/feedback` behind Origin, CSRF and a bounded body; server actor; ≤500 characters; idempotent | Met | `viz-server.test.ts`; `phase-4-evidence.browser.ts` |
| No ledger migration; additive fields | Met | Existing callers unchanged (`viz-server.test.ts`) |

## Per phase

| Phase | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Baseline, failing acceptance cases, isolated harness, benchmark | Met | `phase-0-baseline.md`. All seven defect cases now pass without annotation |
| 1 | Tokens, theme, semantics, responsive shell, focus, 400% zoom | Met | `phase-1-shell.browser.ts` (18) |
| 2 | Ledger views, reasons, paging, headings, Resumable work | Met | Memory 1125 unit tests; `phase-2-memory.browser.ts` (8) |
| 3 | Pure projections, shared dependency set, 50-row paging | Met | `explorer-projection.test.ts` (9) |
| 3 | Presentation selector, synchronization, keyboard journey to source and Blast | Met | `phase-3-explorer.browser.ts` |
| 3 | Distinct loading, failure + Retry, empty index, no matches under filters, no matches | **Met — fixed in audit** | The empty index showed a phantom row. Fixed in `explorer-projection.js`; `phase-5-matrix.browser.ts` loading/empty case |
| 3 | Focus defaults to direct neighbors; Blast table; edge labels only on selection | Met | Projection tests; `draw()` labels only active direct edges |
| 3 | 50k-node fixture, ≤50 rows, no regression | Met | Precise A/B below |
| 4 | Evidence inspection, concern reporting, redaction, isolation | Met | `phase-4-evidence.browser.ts` (10) |
| 5 | Complete the token migration; remove unused accents and duplicate palettes; document tokens | **Met — fixed in audit** | Tints and edges derived with `color-mix()` from the accents; hover/selected/scrollbar tokens; `themeP()` removed, so the canvas reads the tokens; design doc rewritten from `tokens.css` with computed ratios |
| 5 | Compact Memory cards; detail keeps full text, IDs, CLI and lineage | Met | `phase-5-hierarchy.browser.ts` |
| 5 | Published index and reader snapshot shown separately, with revision and time | Met | `memory-view-projection.test.ts`; stale-reader fixture |
| 5 | Async states: loading, partial, stale, error with recovery, success, empty | **Met — fixed in audit** | Source preview `role=alert` + Retry, loading as `role=status`; Retry for evidence and for the Memory home error |
| 5 | Tests at 320/375/768/1280/1440 in both themes; long multilingual content; 200% and 400% zoom; reduced motion; stale/partial/failure; state contrast | **Met — fixed in audit** | `phase-5-matrix.browser.ts` (17); reduced motion in `phase-6-keyboard.browser.ts` |
| 5 | Task study with developers new to the UI | **Open — external** | `phase-5-open-ux-study.md` is ready; no participants have run it yet |
| 6 | Repository checks, `detect_changes`, gate | Met | See verification below; `ui:gate` + tests |
| 6 | Automated + manual assessment of every state | Met (team portion) | 28 states × 2 themes, all passing; keyboard spec (8) |
| 6 | Independent AT assessment, remediation retest, conformance report | **Open — external** | Draft report states no conformance claim |
| 6 | Repeat the four tasks after remediation | **Open — external** | As Phase 5 |

## Performance (precise A/B, same machine, interleaved)

Search is timed inside the page, from the input event to the DOM commit of the result count, using a `MutationObserver`. Frame polling quantizes at about 16.7 ms, which is as large as the differences being compared. Nine samples per tree:

| Measure | Phase 0 (48,662 nodes) | Integrated (49,096 nodes) | Change |
| --- | ---: | ---: | ---: |
| Search (median) | 50.2 ms | 47.5 ms | −5.4% |
| Page startup (median) | 1,585 ms | 1,560 ms | −1.6% |
| Switch to List (median) | — | 85 ms | new |
| Peak rendered result rows | 0 | 50 | cap holds |

Graph presentation now computes only the explorer counts it shows. Ranked, mapped rows are built only when List or Split is visible. This did not change the medians, but it removes work nobody sees.

## Verification

All results below are for this branch after the fixes.

| Gate | Result |
| --- | --- |
| Browser suite (every spec, real isolated backend) | 152/152, with no expected-failure annotations remaining |
| Automated WCAG 2.2 A/AA audit (axe-core 4.13 + contrast + targets) | 56/56 (28 states × 2 themes) |
| Phase 5 matrix (5 widths × 2 themes, states, content, zoom, fixtures) | 17/17 |
| UI unit | 50/50 |
| Memory package | 1125/1125 |
| CLI unit (bounded, `--maxWorkers=2`) | 607/607 across 41 files |
| `security:check`; `security:battery` | Passed; 182 + 65 + 9 tests |
| `pack:check` | 8/8 tarballs, including `explorer-projection.js` and `memory-view-projection.js` |
| Typecheck; Biome (693 files) | Passed |
| `ui:gate:test` | Passed |
| `ui:gate` | UNAVAILABLE: no open A/AA issue; waits on the independent assessment and retests, the task review, and a CI `checks.json` |

`detect_changes` since Phase 6 was large: 4,426 changed symbols and 9,024 removed edges. Most node ids embed line numbers, and the merge shifted lines in `cli.ts`, `viz-server.ts` and the browser harness. The removed `calls` edges pair the same callers and callees at new line numbers. A source diff since Phase 6 removes no function or method definition in `packages/memory` or `packages/cli/src`. This report is a scope signal, not a safety certification.

## Release order

The PRs must merge as one line: #64 → #65 → #67 → #68 → #70 → this audit PR. The audit PR carries the Phase 3 (#69) and Phase 5 (#71) commits through its merge, so #69 and #71 can be closed as merged-via-audit, or merged first on their own stack. Merging #69/#71 into `debug/auditMaster` independently of this PR would reintroduce the split this audit repaired.
