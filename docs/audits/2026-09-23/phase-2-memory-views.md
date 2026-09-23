# Phase 2 — Memory home truth and complete review navigation

Branch `claude/ui-remediation-phase-2`, stacked on Phase 1 (`claude/ui-remediation-phase-1`). Audit coverage: the Needs review dead end, the Active/History mismatch, and count denominators.

## The defect

Memory home took its tile counts from handoff (`counts.active`, `counts.needsAttention`), but the tiles routed somewhere else. Active and History both opened the unfiltered ledger. Needs review opened the `stale` anchor group, a different predicate from the one that produced its count. A reviewer could therefore not reach every record a tile counted, and nothing explained why a record needed review.

## Contract

**Memory API (`packages/memory`).** `LedgerOpts.view?: 'active' | 'needs-review'`. `LedgerResult.views: { active, needsReview }`. Every `LedgerRow` gains `reviewReasons: { code, blocking }[]`. All changes are additive, and no ledger migration is needed.

- **Active** is exactly the recall gate (`row.eligible`).
- **Needs review** is every lifecycle-active record with at least one reason. Blocking reasons are `not-admitted`, `evidence-invalid`, `applicability-needs-review`, `applicability-orphaned`, `quarantined`, and a defensive `not-recall-eligible`. Advisory reasons are `evidence-degraded`, `conflict`, and `concern`. A concern is contradicted feedback that no quarantine has settled, derived with the existing `contradictedForReview` over feedback and decisions gathered once per projection.
- The two views overlap by design: an eligible claim with only advisory reasons (for example, degraded evidence) appears in both.
- Counting and filtering use the single `inLedgerView` predicate, before pagination. Needs review sorts blocking reasons first, then newest activity, then id. Active sorts newest, then id. History keeps the existing group ordering.
- `group` together with `view` throws.

**Viz server.** `GET /memory.json` accepts `view=active|needs-review`. It returns 400 for an unknown view, and for `view` combined with `group`. An omitted `view` is the existing History response plus the additive fields. `/memory/home.json` takes Active and Needs review counts from `ledger.views`, so each tile equals the total of the list it opens. Handoff still supplies Pending and Work, and its agent contract is unchanged. The next-action copy uses the new review count.

**UI.** Memory home is a hub of count tiles, each tagged `data-kc-memory-home-action="<key>"`, with a note explaining the Active/Needs review overlap. Each tile opens its own view, which has:

- an `h3` heading that receives focus
- Back to Memory home, which returns focus to the tile that opened the view
- an explanatory note
- the `from–to of total` range from the response
- Previous/Next 50 paging (`aria-disabled` at the ends, so focus is never dropped)
- a polite announcement of the result count

History alone shows lifecycle tabs, which expose `aria-pressed`. Each Needs review row states its reason and what the reason means for recall (for example, "Evidence degraded — Still recall-eligible — use with caution."). Detail Back returns to the originating view, page, and row. The Work tile is renamed "Resumable work", and inside it one line labels resumable, stale, and closed counts separately. Mutations reload the current view and page, stepping back one page if the list shrank under the reviewer. The Memory badge shows the Needs review count.

Two defects surfaced by the tests were fixed. First, the page range was taken from the requested offset, so it changed before the new rows arrived. It now reads the response's `offset`. Second, switching views left the previous view's rows under the new heading while loading. Switching now clears the rows; paging and refreshes still keep the current rows until their replacement arrives. Memory chips and group labels now use theme text tokens: literal accents on tinted chips had measured 1.6–2.5:1.

## Verification

| Gate | Result |
| --- | --- |
| Memory package | 1118/1118. The new cases cover the pure `reviewReasonsOf` classifier, plus fixtures for valid, degraded, invalid, stale, orphaned, quarantined, conflicting, reported-concern, retired, and staged records. They also check the overlap, count-to-total equality, blocking-first ordering, 230-record paging, the `group`+`view` rejection, and the absence of banned vocabulary |
| Viz server | 33/33: `view` parsing and 400s, the additive response, and tile count equals view total |
| `phase-2-memory.browser.ts` | 8/8 against a real backend seeded with 230 degraded claims plus one reported concern. Each tile's count equals the distinct rows collected across every page of its view (Active, Needs review, and History, each over 200). Also covers heading focus and Back focus return, History-only tabs and the overlap note, reason copy and the concern, detail Back to the same page and row, the Work summary, API 400s, and contrast in both themes |
| Phase 0 acceptance | The Phase 2 case (Active and Needs review destinations) now passes without `test.fail` |
| Full browser suite | 50/50, including 2 remaining Phase 3 expected failures |
| UI unit | 37/37 |
| CLI unit (bounded) | 601/601 across 41 files |
| Typecheck, Biome on changed paths | Passed |

## Not in this phase

- Report a concern from the UI, and evidence inspection, are Phase 4. The `concern` reason reads the feedback that CLI and MCP `memory feedback` already record.
- Handoff's own `needsAttention` count is unchanged, so agents keep their existing contract. Only the home tiles and the next action use the ledger views.
