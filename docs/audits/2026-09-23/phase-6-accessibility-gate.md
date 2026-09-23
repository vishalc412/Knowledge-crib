# Phase 6 — accessibility and release gate (implementation-team portion)

Branch `claude/ui-remediation-phase-6`, stacked on Phase 4. Phase 3 is deferred and Phase 5 is being done in another environment. **This phase is not complete, and cannot be completed by the implementation team.** Its defining step is an independent, product-wide WCAG 2.2 AA assessment by an assessor outside the team, using VoiceOver, NVDA, JAWS, TalkBack and forced colours. What follows is everything the team *can* do: build the gate, run the automated and keyboard half of the assessment across every current state, fix what it found, and hand the assessor a scoped brief.

## Release gate

`corepack pnpm@9.15.0 run ui:gate` (`scripts/ui-release-gate.mjs`, tested by `ui:gate:test`) implements Phase 6 step 5 with this repository's three-outcome rule: **PASS 0, FAIL 1, UNAVAILABLE 2**. It reads five artifacts from `docs/audits/2026-09-23/a11y/`:

| Artifact | Written by | Gate rule |
| --- | --- | --- |
| `checks.json` | `pnpm run ui:checks`, which runs unit, typecheck, browser, security and package, and records HEAD, dirtiness and exit codes | Any non-zero exit → FAIL. Missing, partial, or recorded on a dirty tree → UNAVAILABLE |
| `benchmark.json` | `large-graph-benchmark.mjs`, compared with Phase 0 | Unexplained regression >10% → FAIL |
| `issue-log.json` | Team and assessor | Open or deferred A/AA issue → FAIL. Fixed but not independently retested → UNAVAILABLE |
| `assessment.json` | The independent assessor only | Missing, not WCAG 2.2 AA, or assessor not independent (names matching the team's agents are refused) → UNAVAILABLE. `does-not-conform` → FAIL |
| `ux-tasks.json` | Task review | Fewer than four reviewed tasks → UNAVAILABLE. Any pointer dependence, evidence mistaken for valid, or unreachable counted item → FAIL |

FAIL dominates UNAVAILABLE. A mutation test confirmed that removing the independence rule makes `ui:gate:test` fail. **The gate currently reports FAIL**: A11Y-001, A11Y-012 and A11Y-014 are open, all owned by deferred Phase 3. Independently of those, `checks`, `assessment` and `ux-tasks` are UNAVAILABLE.

## Automated and keyboard assessment

- **`phase-6-a11y-audit.browser.ts`** runs 20 states × 2 themes against the real backend, with reduced motion on, at 1280 px and 375 px. Each run applies:
  - axe-core 4.13, using its WCAG 2.0–2.2 A/AA rule tags. axe-core is a test-only devDependency; the script is injected from disk, so no network is used.
  - the composited text-contrast sampler
  - the target-size check (24 px on desktop, 44 px on phones)

  The states cover the shell, search with and without results, the node inspector and Blast, Help, every Memory view, record detail, open evidence panels, the concern form, and the phone overview, drawer, inspector and Memory detail. **All 40 runs pass.**

- **`phase-6-keyboard.browser.ts`** (8 tests):
  - every desktop tab stop has a visible, unobscured focus indicator
  - focus order follows the visual order
  - Tab wraps inside Memory and inside the phone drawer
  - a complete Memory review works without a pointer
  - reduced motion is honoured
  - hover content can be hovered and dismissed
  - single-key shortcuts can be turned off and never fire with modifiers
  - the search count is announced

- **The large-graph benchmark**, on the same machine and browser as Phase 0, against a fresh index of this worktree (49,096 nodes / 135,463 edges; baseline 48,613 / 131,042):

  | Measure | Phase 0 | Now | Change |
  | --- | ---: | ---: | ---: |
  | Median page startup | 1,653 ms | 1,637 ms | −1.0% |
  | Median search | 71 ms | 68 ms | −4.2% |

## Findings fixed in this phase (awaiting independent retest)

| Id | Criterion | Finding | Fix |
| --- | --- | --- | --- |
| A11Y-002 | 1.4.3 | Memory home counts, next action, conflicts banner, pending/resume chips and actions: 1.5–2.9:1 (light), 3.9–4.3:1 (dark) | Text colours map to theme text tokens; tints and swatches unchanged |
| A11Y-003 | 1.4.3 | Inspector kind label, section titles, relation phrases, provenance badges: 1.05–2.7:1 (light) | Neutral text beside the colour swatch; badges use family tokens |
| A11Y-004 | 1.4.3 | Tooltip kind label 2.3:1; dimmed 11.5 px summary | Token text, 12 px floor, no opacity dimming |
| A11Y-005 | 1.4.3 | "No graph matches" 2.77:1 | Risk text token |
| A11Y-011 | 1.4.3 | Tour primary button 3.16:1 | Selection surface token |
| A11Y-006 | 2.5.8 | Inspector section toggles 17 px; phone Memory controls 26–32 px | 32 px desktop, 44 px phone |
| A11Y-007 | 2.4.3, 1.3.2 | Tab reached the stage controls before Search | DOM reordered to header → rail → stage → inspector (the CSS grid layout is unchanged) |
| A11Y-008 | 2.4.3 / APG | Tab escaped modal layers to the browser chrome | Tab and Shift+Tab wrap within the active modal and its trigger |
| A11Y-009 | 4.1.2 | Inspector disclosures lacked `aria-expanded` | Bound to open state |
| A11Y-010 | 1.4.13 | Tooltip: no Escape, not hoverable, and placed over the node (canvas offsets were applied in shell coordinates) | Escape dismisses from anywhere; 300 ms grace plus hover persistence; positioned beside the node |
| A11Y-016 | 2.1.4 | Single-key F and M could not be turned off | A switch in Help (persisted and guarded); modifier combinations never trigger |
| A11Y-017 | 4.1.3 | Search count not announced | Persistent polite live region |

The canvas now also has an interim `role="img"` text alternative that points to the textual routes. That doesn't close A11Y-012.

## Update after integration (2026-09-24)

All six phases are now integrated on `claude/ui-remediation-audit`. Phase 3 closed A11Y-001, A11Y-012, A11Y-014 and A11Y-015. The audit (`docs/audits/2026-09-24/ui-remediation-audit.md`) fixed A11Y-019 through A11Y-022. No Level A or AA issue is open. The gate reports UNAVAILABLE and waits on the independent assessment, the retests, and the task review. The original record follows.

## Open at the time of this record (since closed by Phase 3)

| Id | Criterion | Owner |
| --- | --- | --- |
| A11Y-001 | 2.1.1 Keyboard: selecting a node, Focus and Blast need a pointer | Phase 3 List view |
| A11Y-012 | 1.1.1 / 1.3.1: no text equivalent of the canvas graph | Phase 3 |
| A11Y-014 | 2.5.7 Dragging Movements: panning needs a drag | Phase 3 (List view or pan controls) |

## Deliverables for the assessor

- [a11y/assessor-protocol.md](a11y/assessor-protocol.md): scope, states, environment matrix, the four tasks, and how to record `assessment.json`, `ux-tasks.json` and retests.
- [a11y/conformance-report-draft.md](a11y/conformance-report-draft.md): every WCAG 2.2 A/AA criterion with a provisional status. It is explicitly *not* a conformance claim.
- [a11y/issue-log.json](a11y/issue-log.json) and [a11y/benchmark.json](a11y/benchmark.json).

## Verification of this branch

See the table in the pull request. The same commands are reproducible with `pnpm run ui:checks` on a clean checkout.

## Coordination with Phase 5

Phase 6 changes `packages/ui/web/index.html` in:
- text colour bindings
- inspector disclosures
- DOM order of `<main>`
- the tooltip
- the key handler
- the Help popover

Phase 5 is migrating tokens in the same file in another environment. Whichever lands second should rerun `phase-6-a11y-audit.browser.ts` and `phase-6-keyboard.browser.ts`. Those two specs are the regression net for the fixes above.
