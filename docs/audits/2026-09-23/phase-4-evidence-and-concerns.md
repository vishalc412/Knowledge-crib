# Phase 4 — evidence inspection and concern reporting

Branch `claude/ui-remediation-phase-4`, stacked on Phase 2. Phase 3 (Graph/List/Split explorer) was deferred at the user's direction, and its two Phase 0 expected failures stay annotated. Audit coverage: RAG evidence traceability, and user correction and control.

## Contract

**Memory API.** `MemoryApi.inspectEvidence(recordId, index)` resolves the record through the same principal-scoped `locate()` that `get()` uses. A missing record, another principal's record, and an out-of-range or non-integer index all return the same `{ found: false }`. The pure `inspectEvidenceItem` in `evidence-inspection.ts` explains each kind:

| Kind | Disclosed | Never disclosed |
| --- | --- | --- |
| Source quote | The saved quote and saved line, the recorded node id, its state in the live index (current, moved with the new node, gone, ambiguous, uncheckable), its file and span, and whether the node's hash changed since the check | — |
| Execution assertion | The named assertion and its outcome from the receipt (`not-recorded` when absent), and a receipt summary: id, run time, HEAD, exit code, output digest | executable, argv, worktree digest, raw output, `meta` |
| Committed policy | Artifact id, anchor, and its live location when the index has it | — |
| Human attestation | Attestor, time, attestation id, whether it was recorded interactively | — |
| Receipt pair | Both receipt summaries (redacted as above), each missing side named, and whether the failing run preceded the passing run (`null` when that cannot be determined) | as for receipts |

The audit `feedback` entries gain an additive `context`, so a reported concern keeps its reason.

**`GET /memory/evidence.json?recordId=&index=`.** The route validates its query (400 for a missing id or a non-integer or negative index) and never accepts a path. Any unavailable item answers the same `404 evidence not found`. A current excerpt is read only through the existing guarded `readVizNodeSource`, by the readable node id. Otherwise the response carries `current: { status: 'unavailable', reason }`, which distinguishes: gone, ambiguous, no index, no span, and file unreadable in this checkout.

**`POST /memory/feedback { recordId, reason }`.** It runs inside the existing mutation boundary: Origin, then CSRF header, then a bounded body. The reason is trimmed and must be nonblank and at most 500 characters. The record must be readable by the caller, otherwise the route answers 404. The actor comes from the server's operator; the body cannot set it. The route writes a local `contradicted` feedback event with **no counter-evidence** through `applyLocalFeedback`. That helper is extracted from `crib memory feedback`, so the browser and the CLI write the same event with the same sync staging. The event id is content-addressed, so repeating a report is idempotent. The response carries `quarantined: result.suppression.suppress`, which is always false without counter-evidence, and the message "Recorded for review; this does not automatically retract or quarantine the claim." The record then appears in Needs review with the Phase 2 `concern` reason and stays recall-eligible.

**UI (record detail).**
- The claim, the verdict chips, and a scope/placement/visibility line come first. The record id, lineage, and the exact CLI routes (`crib memory supersede … --claim`, `crib memory resolve … --retract`) sit in a collapsed Technical details section.
- Each evidence item shows its exact type, its verdict with a plain meaning, its check time, and its reason. An Inspect button (`aria-expanded`, `aria-controls`) opens a panel of facts, a statement where one matters, and either the current source excerpt or a specific unavailable reason. Saved quotes are labelled "as recorded, not necessarily current".
- Report a concern first explains what the action does and does not do. It requires a reason, shows a live character count, submits through the existing grant, announces success or failure politely, shows the returned message, refreshes the detail and the tile counts in place, and lists the concern under Reported concerns. Back reloads the same view and page so the new reason is visible.

## Verification

| Gate | Result |
| --- | --- |
| Memory package | 1125/1125, including `evidence-inspection.test.ts` (7). Every kind is covered, plus: changed-since-check; moved and gone sources; a missing receipt; a missing half of a receipt pair with its ordering; a sentinel secret in receipt argv and `meta` that never appears in the output; and one `found: false` for foreign, missing, and out-of-range items |
| Viz server | 38/38: evidence query parsing, reason validation (blank, missing, over 500) with the client actor ignored, the current excerpt by node id, an unreadable source, and one 404 message |
| `phase-4-evidence.browser.ts` | 10/10 against a real backend seeded with one claim carrying all five kinds, sentinel-bearing receipts, and a vanished source. Covers claim-before-ids ordering and the CLI route; each kind inspected in the rendered page; the sentinel absent from both page and API; 404 and 400 handling; Origin and CSRF refusal; blank-reason refusal; a keyboard-submitted report that records the concern with the claim still eligible and not quarantined; Back to the refreshed row; idempotent repeat reports; contrast in both themes |
| Full browser suite | 60/60, including the 2 remaining Phase 3 expected failures |
| UI unit | 37/37 |
| CLI unit (bounded) | 606/606 across 41 files, including the `crib memory feedback` path now routed through `applyLocalFeedback` |
| Offline package check | 8/8 tarballs |
| Typecheck, Biome | Passed |

## Not in this phase

- Supersede and retract remain explicit CLI operations. The browser shows the exact commands and performs no correction mutation.
- Receipt summaries are principal-scoped by store, like every other read. Receipts carry no principal stamp of their own, so isolation is as strong as the store boundary, the same as the CLI's.
