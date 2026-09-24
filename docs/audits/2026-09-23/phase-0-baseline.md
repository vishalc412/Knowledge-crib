# Phase 0 UI remediation baseline

Captured 2026-09-23 on macOS from HEAD `04f631ae1d4dc9bb838c0272b149687eb78f2cfe` before UI or Memory implementation changes. The source checkout was on `debug/auditMaster` with only `docs/audits/2026-09-23/` untracked. Both audit documents were copied unchanged into the isolated `codex/ui-remediation-phase-0` worktree. The worktree was indexed separately because its initial `.crib/` lacked `crib.json`.

## Index and isolation

- Source checkout index: 49,646 nodes, 136,152 edges, 1,032 clusters; reader fresh at the recorded HEAD. Its published-index signal reported `behindHead: true`, which is separate from reader freshness.
- Worktree index after `crib index --json`: 49,645 nodes, 135,108 edges, 1,032 clusters; reader fresh at the recorded HEAD. The two indices are separate local snapshots, so the counts are not treated as a code regression.
- Browser acceptance tests use `packages/cli/test/browser/backend.ts`: a temporary Git repository, temporary Memory home, and real local `crib viz` process. No acceptance case writes to the developer's Memory store.

## Untouched gates

| Gate | Command | Result before remediation |
| --- | --- | --- |
| Build | `corepack pnpm@9.15.0 -r run build` | Passed, eight packages |
| UI unit | `corepack pnpm@9.15.0 --filter @knowledge-crib/ui run test` | 36 passed |
| CLI unit | `corepack pnpm@9.15.0 --filter knowledge-crib run test` | 596 passed, 3 failed, 1 Vitest worker RPC timeout under concurrent gate load; details below |
| Existing browser | `corepack pnpm@9.15.0 --filter knowledge-crib run test:browser` | 17 passed |
| Typecheck | `corepack pnpm@9.15.0 -r run typecheck` | Passed |
| Offline package | `node scripts/pack-check.mjs` | 8/8 tarballs validated, including UI offline assets |

A repository-wide `biome check .` run after adding the Phase 0 files found two formatting-only baseline errors in unchanged `inspector.browser.ts` and `web-assets.test.ts`. Biome formatting was applied to just those files so the Phase 0 PR can satisfy the lint gate; no assertions or UI behavior were changed.

The three untouched CLI failures were:

1. `freshness.test.ts`: heartbeat age was 59 ms against a 50 ms threshold while five gate commands and indexing ran concurrently.
2. `viz.test.ts`: a static HTML assertion expects the literal `2-hop context`; current UI composes that label dynamically from `hop`.
3. `watch.test.ts`: a debounce timing assertion saw zero requests under the same concurrent load.

An isolated rerun of `freshness.test.ts`, `watch.test.ts`, and `viz.test.ts` passed both timing cases and reproduced only the stale HTML assertion (55 passed, 1 failed). The assertion was then updated to check the Horizon expansion action it was meant to protect; the original failure remains recorded above as a baseline failure.

A second unrestricted CLI run after that correction again finished at 596 passed, 3 failed, with a Vitest worker RPC timeout. This time the failures were a competing freshness lock in `freshness-subprocess.test.ts` and 30-second timeouts in `intake-e2e.test.ts` and `protocol-commands.test.ts`. Because the failing test names changed between runs without corresponding production changes, the default high-concurrency invocation is not a stable comparison gate on this host. The same three files passed in a focused two-worker run (7/7), and `corepack pnpm@9.15.0 --filter knowledge-crib exec vitest run --maxWorkers=2 --reporter=dot` passed the complete suite (41 files, 599/599 tests, 205.91 seconds). Keep the original failures visible; use the bounded command for comparable local runs on this host.

## Reproduced acceptance failures

`packages/cli/test/browser/ui-remediation-baseline.browser.ts` ran against the real isolated backend **without** expected-failure annotations first: 7 of 7 cases failed for the audited symptoms. After recording those failures, the cases were annotated as expected failures until their owning phase removes the annotation. The annotated run passed 7/7 in 36.4 seconds; the complete browser suite then passed 24/24 cases (17 existing plus 7 expected failures) in 1.1 minutes.

One subsequent full browser rerun exposed an intermittent existing Focus zoom test failure. Its initial `>20%` poll could accept the default `100%` label before the fixture graph loaded, then compare that provisional value with the real post-load fit near `62%`. Delaying the graph fixture by 600 ms reproduced the failure; waiting for the rendered `1,809` node count before measuring zoom made the delayed case pass. This is a test-readiness correction, not a UI fit change.

| Case | Observed baseline |
| --- | --- |
| Navigation at 320px and 375px | The rail body remains hidden after the user reopens it. |
| Light-stage contrast | Sampled stage text/surface contrast was 3.00:1, below the 4.5:1 target for ordinary text. |
| Active and Needs review destinations | Active opens a list without an Active heading; the existing routing aliases the History and Stale paths. |
| Keyboard textual exploration | No List presentation control exists; a keyboard user cannot enter a textual symbol explorer. |
| Document semantics | `<html>` has no `lang`, and the page lacks a descriptive title. |
| Zero-result recovery | A no-match graph search offers no `Clear search` action. |

## Large-graph browser benchmark

Reproduce with `node packages/cli/test/browser/large-graph-benchmark.mjs` after building and indexing this worktree. The script launches the actual local CLI and bundled Chromium, uses a separate temporary Memory home, navigates three fresh pages at 1440 × 900 CSS pixels, and searches for the common term `test`. It measures server announcement, graph-ready navigation, search feedback, presentation switch when available, and the peak count of `[data-kc-result-row]` elements.

| Measure | Baseline |
| --- | ---: |
| Rendered graph nodes / edges | 48,613 / 131,042 |
| Server startup | 2,246 ms |
| Page startup, median of 3 | 1,653 ms |
| `test` search, median of 3 | 71 ms |
| Presentation switch | Unavailable: Graph only |
| Peak rendered result rows | 0: no List presentation exists |

The three page startup samples were 1,676, 1,653, and 1,634 ms. Search samples were 78, 69, and 71 ms. Later phases should compare the same script, machine, browser, checkout scale, and conditions. A reported canvas cap or truncated traversal must remain separate from the result total.
