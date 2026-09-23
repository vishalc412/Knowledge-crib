# Knowledge Crib: Developer Trust and Competitive Leadership Plan

> **Provenance** — verbatim record of the plan the principal shared in Claude Code
> session `b89d2180-74c9-45bc-a27a-4b15f53bf450` on 2026-09-22, wrapped by their
> instruction: *"implement the plan … and do eval for all the steps with one round of
> end to end testing on a projct and evaluate as priunciple engineer"* (typos preserved).
> Filed here (`.crib/`, gitignored) because the pre-freeze wave's G1 manifest audit
> forbids new `docs/` files until that wave completes; move to
> `docs/program/developer-trust-plan.md` at the post-freeze step and reference it from
> the evidence register. Program intake:
> `intake:d1dbca6c7ee271923de9164e5163d988181c91e8488fdb3b2bef2fa154c5eae1`.

## 1. Goal and verified baseline

Combine the application audit, unfinished developer-launch work, and connected-memory work into one development program.

**Target:** make Knowledge Crib exceptionally reliable for developers moving between coding agents: accurate code context, evidence-backed memory, understandable uncertainty, and dependable task continuation. Competitive superiority must be demonstrated through reproducible results.

Current evidence:

- Lint and workspace typechecking pass.
- The CLI entrypoint exceeds 10,000 lines; the MCP verb module exceeds 5,000.
- First-party browser assets are excluded from the main lint check.
- Memory evidence evaluation remains bound to the startup graph while code readers can adopt newer snapshots.
- Atomic memory writes use temporary files and rename without explicit disk flushing.
- The saved held-out graph evaluation reports **86.94% evidence-path recall**, below the **90%** gate, plus three emptiness violations and eight forbidden-result violations. These are recorded results, not newly rerun measurements. [Graph evaluation](/Users/vishalchawla/Documents/Knowlege-crib/docs/bench/graph-gates.md)
- Existing release policy requires seven clients across three native platforms, six OS/Node cells, and candidate-bound evidence. Preserve those requirements. [Launch policy](/Users/vishalchawla/Documents/Knowlege-crib/scripts/launch-policy.json)

## 2. Development work packages

### WP0 — Establish the authoritative baseline

- Create one private Knowledge Crib intake linking the existing launch and graph workstreams; preserve their unfinished records.
- Refresh the code graph during execution, record HEAD and working-tree state, and preserve the existing untracked graph plan.
- Reconcile old tasks into **implemented**, **verified**, **failing**, and **externally blocked**, each with supporting evidence.
- Run build, tests, lint, typechecking, browser acceptance, packaging, and applicable release checks in an isolated checkout.
- Produce a prioritized findings register containing reproduction, affected behavior, severity, owner, regression test, and acceptance criterion.

**Exit:** every subsequent task traces to a verified defect, measured limitation, or explicit product requirement. Previously passing results are not treated as current certification.

### WP1 — Repair freshness, durability, and trust boundaries

- Make memory evidence resolution and capture anchoring use the request’s pinned code snapshot. Keep code-reader generation and memory-ledger generation distinct, and invalidate cached evaluations when either relevant generation changes.
- Extend persistent-write handling to flush file contents before replacement and use platform-supported directory durability handling. Surface unsupported guarantees explicitly; never report durable success after a persistence failure.
- Preserve append-only history, idempotent writes, lock discipline, and recoverable projections.
- Audit legacy records without principal ownership. Keep ambiguous records out of shared trusted recall; provide migration preview, backup, explicit ownership assignment, and resumable migration.
- Exercise authorization through search results, graph traversal, counts, pagination, history, exports, and diagnostics.

**Exit:** source changes become visible consistently; invalidated evidence cannot remain current through a stale cache; persistence failures do not produce successful acknowledgements; adversarial isolation tests disclose zero foreign records.

### WP2 — Make connected answers evidence-led

Implement the selected global-memory rule:

- Global memories remain searchable.
- Repository context includes a global claim only when an authorized, temporally valid, supported relationship connects it to the requested repository subject.
- Similarity scores and shared membership in a broad topic are insufficient proof of applicability.
- Unsupported candidates cannot seed answer expansion. Historical and contradictory evidence remain explicitly labeled.
- Preserve complete supporting paths and conflict groups during token-budget trimming; omit an incomplete group and report truncation when it cannot fit.

Use the exposed v1/v2 corpora for development regressions. Freeze the new behavior and retrieval configuration before an independent author creates corpus v3.

**Exit:** at least 90% evidence-path recall on at least 100 held-out multi-hop questions; zero unauthorized paths, forbidden results, and emptiness violations; existing plain-recall gates remain unchanged.

### WP3 — Reduce maintenance risk and close hygiene gaps

- Extract CLI command families and runtime composition from the oversized entrypoint.
- Extract MCP handlers by responsibility: code context, memory lifecycle, connected graph, enrichment, and diagnostics. Retain the existing capability manifest as the registration authority.
- Preserve command syntax, exit codes, tool names, response contracts, and ordering through characterization tests.
- Bring first-party browser JavaScript under linting; exclude only vendored/generated assets. Move inline application logic into testable modules where necessary.
- Add enforced package-dependency boundaries, import-cycle detection, and a ratchet preventing new unjustified unsafe casts, suppressions, or unused exports.
- Extend existing dependency updates with dependency-risk, license, secret, and release-artifact checks. Produce an SBOM for release artifacts.

**Exit:** all first-party executable code is covered by applicable checks; package boundaries are enforced; command dispatchers contain wiring rather than business logic; no unexplained behavior changes accompany extraction.

### WP4 — Improve code retrieval and measured scale

The current index factory does not supply an embedder to code search. Existing memory embeddings therefore do not establish hybrid code retrieval. [Index factory](/Users/vishalchawla/Documents/Knowlege-crib/packages/core/src/index/factory.ts)

- Add an opt-in code-search embedding path through the existing backend interface, using the installed local model.
- Keep vectors derived and rebuildable, keyed by source content and model revision. Batch embedding work and update only changed content.
- Preserve lexical search when the model is unavailable, with explicit capability/degradation reporting.
- Evaluate exact-symbol, natural-language, cross-file, rename, and dependency questions separately.
- Measure cold indexing, incremental updates, query latency, memory, and disk usage on fixed 10k, 100k, and 500k LOC fixtures.
- Promote hybrid search to default only after independent evaluation shows improved natural-language retrieval, no exact-symbol regression, and compliance with preregistered resource budgets. Otherwise retain opt-in status.

**Exit:** published quality/resource measurements replace unsupported scale or semantic-search claims.

### WP5 — Make trust and recovery understandable

- Extend Memory Home to explain why an item appeared, its supporting evidence, freshness, scope, conflicts, and exclusion reasons.
- Separate reusable knowledge from unfinished work; make continuation choices and repository drift understandable without inspecting raw records.
- Provide actionable recovery for stale indexes, unavailable models, blocked extraction, and failed persistence.
- Add keyboard, accessibility, empty-state, offline, and recovery coverage to browser acceptance.
- Validate the complete workflow: save a decision → change its evidence → observe its changed status → continue the task in another agent.

**Exit:** users can understand and repair the tested failure states without editing internal storage.

### WP6 — Complete certification and establish competitive evidence

- Freeze one candidate and certify the existing 21 client/platform cells on real native hosts, including connected memory, restart, and continuation.
- Complete all six OS/Node cells, acceptance receipts, and deep-fuzz requirements.
- Treat unavailable hosts, credentials, and failing cells as explicit blockers; never replace vendor runtime evidence with a harness stub.
- Generate support documentation from validated receipts for that candidate.
- Publish reproducible Crib benchmarks covering stale-memory rejection, evidence correctness, handoff recovery, dependency accuracy, latency, token usage, and setup effort.
- Compare capabilities against the two competitive groups: temporal memory such as [Graphiti](https://github.com/getzep/graphiti), and code context such as [Augment](https://www.augmentcode.com/product/context-engine-mcp) and [Sourcegraph](https://sourcegraph.com/mcp). Accept independently supplied comparable measurements; label missing measurements unavailable.

**Exit:** release only when the unchanged launch policy returns GO. Claim leadership only for specific, reproducibly demonstrated outcomes.

## 3. Interfaces and compatibility

- Preserve existing CLI commands, MCP tool names, capability registration, and readable historical receipt formats.
- Reuse existing graph paths, assertion references, state labels, and degradation fields to explain eligibility.
- Add optional evidence-generation provenance so consumers can identify the code snapshot used to evaluate a claim.
- Introduce an internal request-scoped evidence resolver and optional index embedder configuration.
- Keep canonical memory identities stable. Rebuild derived indexes when model or projection versions change.
- Require explicit preview and backup before ownership migrations; no automatic assignment of ambiguous historical records.

## 4. Acceptance and regression tests

| Area | Required scenarios and gates |
|---|---|
| Freshness | Save, rename, delete, checkout, merge, rebase, external update, restart; preserve the existing ≤5s p95 convergence requirement. |
| Durability | Failure before write, during write, flush, and replacement; process interruption; duplicate retries; disk-full and permission errors. Distinguish process-crash tests from power-loss guarantees. |
| Memory trust | Foreign principals, unstamped legacy records, withdrawn evidence, stale generations, unsupported global claims, scope changes during pagination. |
| Connected retrieval | Independent held-out v3; ≥90% path recall; zero forbidden/unauthorized results; complete conflict and historical labeling. |
| Performance | Preserve existing graph targets: bounded warm reads ≤500ms p95, context assembly ≤1s, update visibility ≤2s on the specified workload. |
| Refactoring | CLI/MCP contract tests, full workspace checks, package boundaries, browser acceptance, packaging and install smoke tests. |
| Release | Exact candidate identity across all required receipts; missing, stale, altered, or mismatched evidence keeps the decision NO-GO. |

## 5. Delivery order and defaults

**Sequence:** WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6. Provision certification hosts during WP0 so infrastructure does not become a late surprise.

- Developer trust is the primary objective; retrieval leadership supports it.
- Retain the existing local-first architecture and vendor-neutral interfaces.
- Cross-device sync retains its current preview status. Enterprise hosting, billing, and new language expansion are outside this release.
- Use small, independently reviewable changes. Run Knowledge Crib impact analysis before edits and change analysis before commits.
- Maintain one evidence register and checkpoint each work package through Knowledge Crib.
- Schedule by acceptance milestones until staffing and host availability are known.
- This planning pass changed no product code. Full test, release, and runtime certification results remain work to perform.