# Phase 3 explorer implementation and verification

Phase 3 was developed from the Phase 0 commit `eef84d7fd350bb69cc5b5ad951510b1794551677` in an isolated `codex/ui-remediation-phase-3` worktree. The user requested Phase 3 while Phase 1 remained in progress; its unfinished edits were preserved in the separate Phase 1 worktree. Phase 2 has not started. This PR is therefore a reviewable Phase 3 slice and does not imply that the earlier phases or the final accessibility gate are complete.

## What changed

- `explorer-projection.js` supplies pure overview, module, cluster, search, Focus, and Blast result projections. It uses the graph model's indexed edges and a shared dependency relation set. A cached prepared projection feeds 50-row pages, so switching presentation does not re-sort or insert the repository into the DOM.
- The existing DC shell offers Graph, List, and Split. Desktop starts in Graph, viewports below 760 CSS pixels start in List, and Split is offered from 1280 pixels. Shrinking a Split viewport shows List while retaining the Split preference for a return to desktop width.
- List and Split expose semantic rows with qualified name, type, path, summary, relationship, hop, and an Open or Inspect action. Clusterless file modules open their indexed symbols directly. Blast uses a table grouped by hop and module. Search keeps all ranked matches for List while the canvas retains its small display cap.
- The List, canvas, and inspector use the same selection, query, filter, and page state. A keyboard selection enters the next heading or inspector heading; Back returns to the originating result and page. Pointer selection does not move focus into the inspector.
- Graph loading failures show Retry. Empty search and filtered states identify the code-graph scope and offer the relevant recovery action. Result totals, canvas caps, and traversal limits have separate wording. Blast counts are called discovered affected nodes, with an explicit limit notice when traversal stops.

## Verification

| Gate | Result |
| --- | --- |
| Pure explorer projections | Eight cases: ranking, scope navigation, direction, filtering, Blast order, truncation, and 50-row paging |
| UI unit suite | 44/44 passed |
| Browser suite | 30/30 passed on the final rerun; five Phase 1/2 baseline cases retain expected-failure annotations |
| Typecheck | Eight packages passed |
| Biome | Repository-wide check passed, 678 files |
| Offline package check | Eight of eight tarballs validated; `explorer-projection.js` included |
| CLI unit suite | 599/599 passed across 41 files with one worker. A preceding two-worker run reached 598/599 because an unrelated refresh-coordinator test hit `ENOTEMPTY` while cleaning a temporary `.git` directory; its 23 cases then passed in isolation. |

The Phase 0 expected-failure annotations were removed for keyboard List access and zero-result recovery. The Phase 1 and Phase 2 annotations remain until their phases are implemented.

Knowledge Crib's dirty index and expanded review covered all ten staged paths and all 34 changed declarations. `detect_changes` reported only uncommitted paths because this branch has no commits beyond its Phase 0 anchor. Its removed-edge set includes generated documentation references and execution edges that shifted during the dirty reindex; the checked source diff removes no graph-model callable. This graph report is a scope signal, not a safety certification.

## Large-graph comparison

The same real local benchmark script and Chromium setup used in Phase 0 ran three fresh 1440 × 900 pages after indexing this worktree. Its graph has 48,660 rendered nodes and 132,470 edges, close to the Phase 0 graph of 48,613 nodes and 131,042 edges. Differences reflect the separate worktree index, not a production migration.

| Measure | Phase 0 | Phase 3 |
| --- | ---: | ---: |
| Server startup | 2,246 ms | 2,203 ms |
| Page startup median | 1,653 ms | 1,598 ms |
| Search `test` median | 71 ms | 75 ms |
| Switch to List median | Unavailable | 84 ms |
| Peak rendered result rows | 0 | 50 |

The 4 ms median search difference is small relative to the scale and run-to-run samples (Phase 3: 82, 74, 75 ms). No material startup or search regression was observed. The presentation switch measurement includes construction of the first 50 visible rows; its Phase 0 value is unavailable because the control did not exist.
