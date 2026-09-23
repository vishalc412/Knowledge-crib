# Combined-tree audit: Master + developer-trust + UI remediation

Audited 2026-09-24 on branch `claude/audit-merged-changes-61ae05`. The question was whether the merged
work holds together as one product, checked against the UI remediation plan (Phases 0–6) and the
developer-trust program (WP0–WP5).

## 1. The merges had not produced one tree

The UI remediation shipped as stacked pull requests. Each PR was merged into its **base branch**
after that base had itself already been merged, so the work never reached a mainline:

| PR | Merged into | At (UTC) | Effect |
| --- | --- | --- | --- |
| #64 Phase 0 | `debug/auditMaster` | 19:59:29 | the only phase that reached a long-lived branch |
| #65 Phase 1 | `codex/ui-remediation-phase-0` | 19:59:41 | after #64 had merged, so it never left the phase-0 branch |
| #67 Phase 2 | `claude/ui-remediation-phase-1` | 19:59:54 | same pattern |
| #69 Phase 3 | `codex/ui-remediation-phase-0` | 20:02:14 | same pattern |
| #68 Phase 4 | `claude/ui-remediation-phase-2` | 20:02:26 | same pattern |
| #71 Phase 5 | `codex/ui-remediation-phase-3` | 20:03:23 | same pattern |
| #70 Phase 6 | `claude/ui-remediation-phase-4` | 20:03:37 | same pattern |
| #72 audit | `claude/ui-remediation-phase-6` | 20:03:46 | the only tip that contains all six phases |

Before this branch, `Master` (7cf689c2) contained **none** of the UI remediation. The
developer-trust program (#66, still open) was a third line. Both descend from `caaf42c3`. They had
never been merged together or tested together.

This branch fast-forwards to `program/developer-trust` (#66, which already contains `Master`) and
merges `claude/ui-remediation-phase-6` (3a91b129), the one tip holding every phase plus the #72 audit.

## 2. Conflicts, and how each was decided

There were 36 conflict hunks in 8 files. Both workstreams changed the same Memory surfaces, so most
hunks needed a decision rather than a pick of one side.

| Area | Developer-trust (WP5/WP3) | UI remediation (Phases 2–6) | Resolution |
| --- | --- | --- | --- |
| Ledger options (`ledger.ts`, `api.ts`) | `revalidate`, per-row `reasons`, `excludedBy` | `view`, `views`, `reviewReasons` | Both kept. `eligible`, `excludedBy` and `reviewReasons` now come from one `recallExclusionClause` walk, so the label, the recall gate and the working views cannot disagree. |
| `/memory.json` query | `revalidate` defaults to on | `view` added; rejected with `group` | Both kept. |
| Home tile counts (`readMemoryHome`) | "deliberately not re-checked" (the counts were group counts) | counts from `ledger().views` | **Changed to re-check.** The view counts read `eligible` and the evidence verdict, which a re-check can overturn. Folded from stamps, a tile would count a claim as Active while the list it opens files it under Needs review. That breaks Phase 2's exit criterion. A new test covers this; it fails without the change. |
| Next-action ladder | dead captures → stale index → pending → … → no model | pending → stale work → Needs review | Merged into one ladder. WP5's order is kept, and it now uses the Needs review count behind the tile. |
| Health tiles | per-tile repair line (`recoveryFor`) | split Published index / Reader snapshot tiles | Phase 5 tiles now carry WP5's server-chosen repair line (`healthSignals(health, recovery)`). A **Capture** tile is restored: Phase 5 had dropped "Last capture", which left the capture repair line with nowhere to render. |
| Memory read failure | one panel-level error block (renders on the first failed read; offline vs server) | a home error and an in-list error, both with Retry | **One surface.** WP5's panel-level block now has Phase 6's `role="alert"`, the `data-kc-memory-error` hook and Retry. |
| Ledger rows | "Not recalled" panel with the evaluator's reason codes | compact card with review reasons | Both. WP5's panel is restyled to Phase 1's 12px floor and semantic tokens. WP5's conflict-chip join is dropped because Phase 2's `conflict` review reason covers it. |
| Canvas helpers | WP3-H4 moved `hex/esc/ellipsize/rr` into `graph-model.js` | redrew the overview, focus and tooltips with `this.hex(…)` etc. | Phase 3/6 drawing kept. Every helper call goes through `KCGraphModel`, and `graph-model.js` exports both sides' functions. |
| Browser fixture (`backend.ts`) | `seed: false`, `seedExclusions` | `reviewClaims`, `evidenceKinds`, `longContent` | One options object. The UI seeds run inside the `seed` switch. |

## 3. Failures found only by testing the combined tree

None of these could appear on either line alone.

1. **The boundaries gate (WP3 R6) failed.** Phase 6's `test/browser/axe.ts` added three
   `biome-ignore` markers and one `as any`. **Fixed** by typing the helper with axe-core's own
   declarations, not by raising the baseline.
2. **The credential gate failed** on Phase 4's redaction sentinel in
   `packages/memory/src/evidence-inspection.test.ts`. The file was read, and the string is a
   planted marker the test proves never leaks. **Allowlisted** with that reason.
3. **The license gate failed** on `axe-core` (MPL-2.0), which Phase 6 added as a devDependency.
   **Allowlisted, pending owner confirmation.** It is dev-only, unmodified, and absent from every
   published tarball (`pack:check`). This is a policy call for the owner, not a technical one.
4. **The UI's JavaScript was newly under lint (WP3).** Six lint findings in
   `explorer-projection.js`, `memory-view-projection.js` and `graph-model.js` were fixed.
5. **Phase 2's 200-claim fixture stopped being "degraded".** It stamped `degraded` over evidence
   that grounds. With WP5's default re-check, the evaluator re-derived those claims as `valid`, and
   Needs review fell from over 200 to 2. **Fixed in the fixture**, so the claims are degraded by the
   evaluator's own rule (a relayed, terminal-unconfirmed attestation, `relayed-unconfirmed`), not by
   a stamp.
6. **WP5's browser tests assumed the ledger was the default Memory view.** After Phase 2, Memory
   home is the default and the ledger is History. The tests now enter History by its tile (by
   keyboard in the keyboard test) and go back to home for the tiles. They switch theme through the
   system preference, because Phase 1 made Memory modal and the header toggle is correctly inert
   behind it. They measure the recovery-line contrast on home, where that line now lives.
7. **Phase 5's compact-card test assumed the first History row needed no review.** With WP5's
   drifted claim in the fixture, that row correctly offers "Review claim". The test now picks a row
   that has no review reasons.

## 4. Verification on this branch

| Check | Result |
| --- | --- |
| build, typecheck (all packages) | pass |
| `biome check .` (746 files) | pass |
| unit: ui 69, memory 1188, core 432, pipeline 286, parsers 506, soul-schema 18, cli 670 + 1 new | pass |
| unit: mcp 490/490 | tests pass; exit 1 on the `onTaskUpdate` worker-IPC timeout, register item B11 (pre-existing, load-sensitive; this merge touches nothing in `packages/mcp`) |
| browser (Playwright, real isolated backend) | see the PR description for the final run |
| `boundaries-check`, `credential-check`, `license-check`, `security:check`, `pack:check` 8/8 | pass |
| `installer:test`, `release:metadata`, `ui:gate:test`, `boundaries-check.test` | pass |
| `ui:gate` | UNAVAILABLE (by design): the independent WCAG 2.2 AA assessment, the task study and a CI `checks.json` are outside the implementation team |

## 5. Still open, and not closable by this branch

- The independent WCAG 2.2 AA assessment and retest (Phase 6), and the task study (Phases 5 and 6).
  The assessor brief is `docs/audits/2026-09-23/a11y/assessor-protocol.md`.
- The owner's decision on MPL-2.0 for dev tooling (item 3).
- `crib detect_changes` was not run. The knowledge-crib MCP server failed to connect in this
  session, and this worktree has no index of its own. The review above rests on the diff, the
  conflict-by-conflict reading and the test suites, not on the graph.
