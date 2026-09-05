# Knowledge-crib — MCP API Spec

> The product surface [Q22, Q33]. One MCP server over stdio (`npx knowledge-crib serve`), unified
> verb namespace, resolves `.crib/` from the repo root → serves **that project's** soul. Reads the
> `IndexStore` (fast), falls back to `SoulStore`. All payloads are **token-bounded + provenance-tagged**.

---

## Tool consolidation (current surface: 16 tools / 46 operations)

Fourteen tools that differed only in which verb they called were folded behind an `op` parameter.
Every tool costs name + description + JSON schema in the tool list of **every** session whether or
not it is used, so a family of five rarely-used tools was a permanent tax on every conversation.
The consolidated surface is 16 tools / 46 operations — down from 31 tools / ~6,249 tokens, a 42%
token cut with no capability removed.

These counts are not prose: they are derived from the single capability manifest
(`packages/mcp/src/capabilities.ts`), which also generates each dispatcher's `op` enum, and the
`capabilities:check` release gate fails when this doc states a count the manifest contradicts
(adding an op is a one-line manifest change — the doc must follow or the build goes red).

| Was | Now |
|---|---|
| `enrich_status` | `enrich({op:'status'})` |
| `enrich_next` | `enrich({op:'next'})` |
| `enrich_save` | `enrich({op:'save'})` |
| `semantic_delta` | `enrich({op:'delta'})` |
| `audit_llm` | `enrich({op:'audit'})` |
| `impact` | `impact({op:'blast'})` *(default — `op` may be omitted)* |
| `federatedImpact` | `impact({op:'federated'})` |
| `shortest_path` | `impact({op:'path'})` |
| `ownership` | `impact({op:'owners'})` |
| `dossier` | `dossier({op:'one'})` *(default)* |
| `reconstruct` | `dossier({op:'package'})` |
| `dossier_by_scope` | `dossier({op:'scope'})` |
| `extract_rules` | `dossier({op:'rules'})` |
| `neighbors` | `neighbors({op:'edges'})` *(default)* |
| `llm_neighbors` | `neighbors({op:'llm'})` |
| `describes` | `neighbors({op:'describes'})` |
| `status` | `status({op:'health'})` *(default)* |
| `stats` | `status({op:'stats'})` |
| `gaps` | `status({op:'gaps'})` |
| `memory_get` / `memory_status` / `memory_audit` / `memory_feedback` | `memory({op:'get'\|'status'\|'audit'\|'feedback'})` |

`memory` also gained `memory({op:'capture'})` — loose one-shot observations (subject + observation,
optional files/symbols auto-anchored to the first resolvable spanned symbol) written straight to the
candidate-trust tier, never directly to a trusted store. At Gate 1.3 it gained five more ops —
`search` / `supersede` / `delete` / `history` / `sync`, the portable memory op set — which have no
prior standalone tool: they are NEW operations (routed to the portable `MemoryApi` in
`packages/memory/src/api.ts`), not consolidations of existing names.

When the host has initialized the intelligence event plane, `memory({op:'status'})` also returns a
`freshness` map keyed by projector. `memory-capture` reports its last successfully published
generation, source-event watermark, lag, pending/dead-letter counts, and failure state. The field is
absent for an uninitialized or older host; it is operational provenance, not an assertion that a
claim is trusted or current.

Still standalone, deliberately: `brief`, `context`, `query`, `source`, `detect_changes`,
`overview` — reached for constantly, where an extra `op` would be friction or breakage.
`explain` is also standalone (on-demand PDG + taint for one callable — see its section below);
it is a NEW operation, not a consolidation. `rename` (G5.1, safe symbol rename) is standalone for
the same reason — see its section below; it is a NEW operation, not a consolidation.
`memory_recall` and `memory_observe` are the two memory names the installed client protocols and
project instruction files cite directly, so they stay standalone as **compatibility adapters for
one release cycle**: folding them under `memory` now would break every deployed instruction block
at once. Their contracts are documented in the memory ledger section below, and they retire one
cycle after the portable memory op set lands under `memory({op})`.
(`extract_rules` had no keep-standalone rationale and is now
`dossier({op:'rules'})`; its name lives on in `RETIRED_ALIASES`.)

An under-specified `op` returns `{ error: { code: 'BAD_REQUEST' } }` rather than forwarding a
partial call to a verb.

---

## Conventions
- Transport: MCP stdio. Each verb = an MCP tool.
- IDs follow the [data-model](knowledge-crib-data-model.md) grammar.
- All list responses support `limit` (default per verb) and return `truncated: boolean` + `cursor?`.
- Every edge-bearing result carries `{method, provenance, confidence, evidence}` so agents can filter to `EXTRACTED`-only.
- Errors: `{ error: { code, message, detail? } }`, codes: `NOT_INDEXED | NOT_FOUND | AMBIGUOUS | BAD_ARGS | INTERNAL`.
- **Enrichment via host LLM:** for optional enrichment (cluster naming, NL→query) the server uses MCP `sampling` — the IDE's own model [Q18]. Requires client sampling support; degrades gracefully (skipped) if absent. **Never used on deterministic verbs** (`context`/`impact`/`query`/`neighbors`/`impact({op:'path'})`).
- **Functional map + importance ranking (overview v2):** the soul is segmented on demand into
  architecturally meaningful modules (workspace packages when `crib index` stamped them, else
  directory prefixes with a >80% monorepo-descent rule). Every node carries an `importance` signal
  (directed in-degree over architectural rels — `calls`/`imports`/`inherits`/`implements`/`exposes`/
  `injects`/`renders`/`produces` — decorated by a kind base weight, noise kinds ×0.1). The enrich
  queue and the overview analyses are ordered by importance desc with test paths deprioritized, so
  production symbols are authored/surfaced before test scaffolding. Computed in `@knowledge-crib/core`
  and shared by `ui` and `mcp` (no `module` NodeKind; `SCHEMA_VERSION` stays 1.3).

---

## `status`
Health + whether the project is indexed.
```jsonc
// req: {}
// res:
{ "indexed": true, "schemaVersion":"1.3", "stats":{"nodes":12044,"edges":31188,"clusters":37},
  "vcsHead":"a1b2c3", "incrementalSince":"a1b2c3", "capabilities":{"embeddings":false} }
```

## `index`
Full index of the current repo (writes soul + builds index).
```jsonc
// req: { "path":".", "include?":["src/**"], "exclude?":["**/*.test.ts"], "semantic?":false }
// res: { "ok":true, "stats":{...}, "durationMs": 18230 }
```

## `update`
Incremental update from changed files.
```jsonc
// req: { "since?":"<git sha>" }   // defaults to manifest.incrementalSince
// res: { "ok":true, "changedFiles":7, "chunksRewritten":9, "stats":{...} }
```

## `context(symbol)`
360° context for one symbol: signature, neighbors, cluster, and **linked docs**. The `node` shape
surfaces every captured deep field the extractor recorded (not just the symbol header): for a column
that means `schema`/`table`/`dataType`; for a statement `sqlKind`/`expr`; for a condition `branch`;
for a doc-section `heading`/`anchor`; for a PL/SQL object type `attributes`; for a collection type
`collection`; for a table/view `columns`/`returnType`/`tables`/`kindMeta`. Schema-1.2 behavior nodes
add `errorCode`/`errorMessage` (raise), `whenSelector` (exception-handler / case-branch),
`assignTarget` (assignment), `cursorQuery` (cursor), `commentRef` (explanation). Only present fields
are included, so the shape stays honest per node kind.

Set `withSource` to fold in the **full source body** of the node's span, rehydrated from disk and
budgeted (`sourceMaxChars`/`sourceMaxLines`); set `withRules` to fold in the decision table for a
procedure/function (delegates to `extract_rules`, omitted for other node types). Set
`withFramework` (schema 1.3, opt-in) to fold in the **framework-semantics** relationships the node
participates in — the resolved complement to a symbol's header. Auto-scopes by node: a class
(`@Controller`/`@Configuration`/`@Entity`, or any class/interface/record/struct with incoming
`member-of` children) aggregates its members' route table / bean inventory / DI graph / relation
model; a callable/component/field returns its own direct edges. Returns `framework` only when the
node has framework edges (omitted for a non-Spring method, so the shape stays honest). A
`@Bean`-supplied dependency surfaces as `kind:'produces'` + the producer brief in the **same**
object (one-hop supply chain, no round-trip). Unresolved `meta.injects`/`meta.produces` type names
surface as `⚠ unresolved` entries (parity with `status({op:'gaps'})`).

```jsonc
// req: { "id":"sym:src/auth/AuthService.ts#AuthService.login@L42", "docLimit?":3,
//        "withSource?":true, "withRules?":true, "withFramework?":true,
//        "sourceMaxChars?":4000, "sourceMaxLines?":200 }
// res:
{ "node": { "id":"…","name":"login","qualifiedName":"AuthService.login","signature":"…","type":"method",
            "file":"src/auth.ts","span":{"start":42,"end":58},"clusterId":"c:auth" },
  "callers":  [ { "id":"…","name":"handleLogin","qualifiedName":"Controller.handleLogin",
                 "file":"src/http.ts","line":10,"confidence":1.0 } ],
  "callees":  [ { "id":"…","name":"TokenService.issue","qualifiedName":"TokenService.issue",
                 "file":"src/token.ts","line":88,"confidence":1.0 } ],
  "docs": [ { "sectionId":"doc:docs/auth.md#sessions","heading":"Sessions","anchor":"sessions",
              "snippet":"`AuthService.login` issues…","edgeType":"describes",
              "method":"explicit","provenance":"EXTRACTED","confidence":0.95 } ],
  // withSource only — the full rehydrated body (the deep code context):
  "source": { "text":"login(user, pass) {\n    return issue(user, pass);\n  }",
              "truncated":false, "totalLines":2 },
  // withRules only, and only when the node is a procedure/function:
  "rules": { "rules":[ { "action":{ "kind":"executes","sqlKind":"insert" },
                         "guard":"cond:…@L7","branch":"THEN",
                         "conditions":[ { "polarity":"THEN" } ] } ] },
  // withFramework only — the resolved framework relationships (schema 1.3; Spring track built):
  "framework": { "routes":[ { "id":"route:POST /api/auth/login@src/auth.ts#L42",
                               "httpMethod":"POST","routePath":"/api/auth/login",
                               "handler":"sym:…#AuthService.login@L42",
                               "params":[ {"name":"dto","in":"body"} ],
                               "security":{ "PreAuthorize":"isAuthenticated()" } } ],
                  "produces":[ { "id":"…","name":"SessionToken","producer":"sym:…#TokenService.issue@L88" } ],
                  "dependencies":[ { "id":"sym:…#UserRepository","name":"UserRepository",
                                      "kind":"injects" } ],
                  "dependents":[ { "id":"sym:…#AuthController","name":"AuthController" } ],
                  "relations":[ { "field":"applicant","type":"Loan",
                                  "cardinality":"ManyToOne","fetch":"FetchType.LAZY" } ],
                  "renders":[ { "id":"comp:…#LoanForm","name":"LoanForm" } ] },
  "truncated": false }
```

## `source(node)` *(deep-context)*
The "give me the body" verb — the full source text of one node's span, rehydrated from disk and
budgeted. This is how crib surfaces **low-level code context** the lean soul references but never
copies: a procedure body, a CREATE TABLE DDL, a single DML statement, a doc section. Works for any
node of any language (the rehydration is span-based and language-agnostic). `NOT_FOUND` for an
unknown id; an empty `source.text` (`truncated:false`) when the node has no file/span on disk.

```jsonc
// req: { "id":"sym:…#PKG_LOAN_RULE_ENGINE.RESOLVE_AND_EVALUATE_RULES@L120", "maxChars?":4000, "maxLines?":200 }
// res:
{ "node": { "id":"…","qualifiedName":"…","file":"…","span":{…} },
  "source": { "text":"PROCEDURE RESOLVE_AND_EVALUATE_RULES (…) IS\n  …\nEND;",
              "truncated":true, "totalLines":480 } }
```

## `explain(node)` *(on-demand PDG + taint — opt-in)*
Static analysis for ONE callable: builds a per-function program dependence graph (control
dependence from post-dominators + data dependence from reaching definitions) and reports
source→sink taint flows over a small conservative rule table. TypeScript/JavaScript only, and it
is **opt-in by design**: nothing runs during `crib index`; the analyzer runs per call, reads the
file fresh, and the first run stamps `capabilities.pdg` in the manifest. The rule table is plain
data and caller-extensible (`extraRules` — the CLI exposes it as `crib explain <id> --rules
<file>`; the table and its extension contract are documented in [pdg-taint](pdg-taint.md)).

Response carries `graph` (node/control/data edge counts), `flows` (each with `sinkRule`,
`sourceRule`, `variable`, `contexts`, and a `path` whose steps link back to graph nodes on the
same line), `sinksChecked`, a `limits` array, and — when `flows` is empty — an `absence` message.

```jsonc
// req: { "id":"sym:src/http.ts#Controller.handleLogin@L5", "extraRules?":[ … ] }
// res:
{ "symbol":"handleLogin", "node":"sym:…", "file":"src/http.ts",
  "graph":{ "nodes":12, "controlEdges":4, "dataEdges":9 },
  "flows":[{ "sinkRule":"sink.code-eval", "sourceRule":"source.http-input", "variable":"q",
             "contexts":["code"], "path":[{ "node":3, "line":12, "text":"eval(q);", "via":"data",
                                           "graphNode":"stmt:…" }] }],
  "sinksChecked":1, "limits":[ "…", "…" ] }
```

**Honesty clause (load-bearing):** an empty `flows` list is **NOT proof of safety**. The analysis
is intra-procedural — values passed to other functions, returned to callers, or stored in shared
state are not followed — and it is a conservative over-approximation, so a missing edge may be a
modeling limit. When no sink matched the rule table at all, the response says *nothing was
checked* rather than implying a clean result. Errors: `UNSUPPORTED_LANGUAGE` (non-TS/JS node),
`NOT_CONFIGURED` (analyzer not wired into this server instance), `NO_BODY` (no function body found
for the symbol).

## `rename(from, to)` *(safe symbol rename — plan/apply, G5.1)*
The one graph operation that can destroy work gets the heaviest guard set. Default is a
**dry-run**: it derives the reviewed plan and returns it with a deterministic `planId` (blake3 over
the canonical plan body — file content hashes, edit counts, affected symbols — no wall-clock
input, so the same graph + same files always reproduce the same id). Applying REQUIRES that id.

```jsonc
// 1) dry run — req: { "from":"sym:src/auth.ts#verifyToken@L12", "to":"checkToken" }
// res:
{ "applied": false, "planId": "rename:9f2c…",
  "target": { "id":"sym:…", "name":"verifyToken", "file":"src/auth.ts", "line":12 },
  "counts": { "exact": 9, "inferred": 3, "files": 4, "edits": 12 },
  "files":  [ { "path":"src/auth.ts", "contentHash":"blake3:…", "edits":2, "sites":[ … ] } ],
  "affected":  [ { "id":"sym:…", "distance":1, "rel":"calls", "resolution":"resolved" } ],
  "unresolved":[ { "id":"sym:…", "resolution":"unresolved", "riskNote":"…" } ],
  "next": "review the plan, then call again with apply: true and this planId; …" }

// 2) apply — req: { "from":"…", "to":"checkToken", "apply":true, "planId":"rename:9f2c…" }
// res:
{ "applied": true, "planId": "rename:9f2c…", "filesChanged": 4, "edits": 12,
  "next": "the derived index is now stale — run `crib update --dirty` (or a full `crib reindex`) …" }
```

Guard set (each load-bearing):
- **Default dry-run.** Nothing is written unless `apply: true` AND `planId` are supplied.
- **Deterministic plan id.** Content hash of the plan body (per-file blake3 content hashes taken
  at plan time + edit counts + affected set). No clock input — reproducible byte-for-byte, and any
  file change re-derives a different id.
- **Stale-plan rejection.** Apply re-derives the plan from the CURRENT graph + files: a mismatched
  id returns `PLAN_MISMATCH`; a file whose current hash differs from its plan-time hash returns
  `STALE_PLAN` ("re-run the dry run"). The plan is never persisted — it is re-derived on apply.
- **All-or-nothing.** Every file is read, hash-checked, and rewritten in memory FIRST; nothing is
  written until the whole set validates. A write failure mid-commit restores every already-written
  file (the response names them under `rolledBack`), so the net effect of a failure is "nothing
  changed".
- **Confidence classification.** `exact` sites are the definition span plus references grounded by
  an EXTRACTED edge; `inferred` sites are word-boundary text hits (comments, docs, dynamic
  dispatch) — always flagged in `counts` and `notes`, never silently merged with exact ones.
- **Unresolved bucket.** Dependents reached only by inferred edges land in `unresolved` with a
  risk note; an empty caller set is called out in `notes` as NOT evidence the symbol is unused.

Site classification: the rewritten token is the symbol's SIMPLE name (a qualified `from` anchors
the node; identifiers in code are unqualified — the plan says so in `notes` when the two differ).
The rename does NOT reindex (the MCP server cannot run the pipeline): the apply response says the
index is now stale and to run `crib update --dirty` (or restart `crib serve`, which self-heals).
Errors: `NOT_FOUND` (no symbol matches), `INVALID` (same from/to, or a node with no source file),
`BAD_REQUEST` (`apply` without `planId`), `PLAN_MISMATCH`, `STALE_PLAN`, `IO` (with `rolledBack`).

## `dossier(symbol)` *(deep-context, persisted — Workstream D/E)*
The **one-shot** deep reusable context for a symbol — the highest-leverage verb for a local LLM.
Folds into one artifact: the deep node fields, the paged rehydrated source body, callers/callees,
linked docs, the decision table (for a callable), AND the schema-1.2 control-flow constructs
(`raises`/`handles`/`iterates`/`declares`). Pure over the soul + repoRoot, so it is **persisted**
under `.crib/dossiers/<shard>/` (sharded by `blake3(nodeId).slice(0,2)`, atomic, hash-anchored to
the node's `hash`): a repeat for an unchanged node is a disk cache hit, and the persisted artifact
is byte-identical in shape to the live verb output (the pipeline builds it post-resolve via the same
code path the verb uses on a cache miss).

`format:'markdown'` returns a deterministic Markdown projection (fixed section order: `## Source`,
`## Callers`, `## Callees`, `## Decision table`, `## Raises`, `## Exception handlers`, `## Iterates
(cursors)`, `## Declares`, `## Docs`) — diffable across languages (PL/SQL vs a C# migration). A paged
request (any of `sourceMaxChars`/`sourceMaxLines`/`sourceStartLine`) always rebuilds the default page
fresh; the cache holds the default page only.

```jsonc
// req: { "id":"sym:src/auth/AuthService.ts#AuthService.login@L42",
//        "includeTables?":true, "sourceMaxChars?":4000, "sourceMaxLines?":200,
//        "sourceStartLine?":120, "extractedOnly?":true, "format?":"json"|"markdown" }
// res (format=json):
{ "id":"…","schemaVersion":"1.3","nodeHash":"blake3:…","builtAt":"2026-06-25T…",
  "node": { "id":"…","name":"login","type":"method","signature":"…","file":"…","span":{…} },
  "source": { "text":"login(user,pass){…}","truncated":false,"totalLines":17 },
  "callers":[ {…} ], "callees":[ {…} ], "docs":[ {…} ],
  "rules": { "conditions":["v_amt > 50000","v_score >= 700",…], "rules":[ {…} ] },
  "controlFlow": { "raises":[ {"errorCode":"-20001","errorMessage":"…","confidence":1} ],
                   "handles":[ {"whenSelector":"NO_DATA_FOUND","confidence":1} ],
                   "iterates":[ {"name":"c_app","confidence":1} ],
                   "declares":[ {"kind":"cursor","name":"c_app","cursorQuery":"SELECT …","confidence":1} ] } }
// res (format=markdown): { "id":"…","markdown":"# AuthService.login\n\n- kind: symbol\n…\n## Source\n```…\n## Decision table\n…\n## Raises\n- -20001 …\n## Exception handlers\n- WHEN NO_DATA_FOUND …\n" }
```
`NOT_FOUND` for an unknown id; a callable with no behavior constructs simply omits `controlFlow`.

## `impact(symbol, dir)`
Blast radius + the docs describing affected nodes. **The wedge verb.**
```jsonc
// req: { "id":"sym:…#AuthService.login@L42", "dir":"up"|"down", "depth?":2, "docLimit?":3 }
// res:
{ "root":"sym:…#AuthService.login@L42", "dir":"up",
  "affected":[ { "id":"sym:…#handleLogin@L10","rel":"calls","distance":1,"risk":"high",
                 "docs":[ { "sectionId":"…","snippet":"…","edgeType":"describes",
                            "provenance":"EXTRACTED","confidence":0.9 } ] } ],
  "relatedDocs":[ { "sectionId":"doc:docs/auth.md#sessions","confidence":0.95 } ],
  "truncated": true, "more":"call impact again with cursor" }
```

## `query(hybrid)`
Hybrid BM25 search over code + docs (names/signatures/headings/files AND rehydrated source bodies +
in-soul logic fragments — matches rule content like `DTI > 0.43`, not just signatures). LLM semantic
discoveries that BM25 missed are surfaced separately in `llmHits`.
```jsonc
// req: { "q":"where is the session token issued?", "kinds?":["symbol","doc-section"], "limit?":10,
//        "extractedOnly?":false, "withSource?":false, "withRules?":false,
//        "withFramework?":false, "withLlm?":false }
// res:
{ "hits":[ { "id":"sym:…#TokenService.issue@L88","kind":"symbol","score":0.81,
             "snippet":"issue(userId):Session","clusterId":"c:auth",
             "llm":{ "provenance":"LLM","model":"…","stale":false,"confidence":0.9,
                     "purpose":"Issues a session token after auth." } } ],
  "llmHits":[ { "id":"sym:…#SessionCache@L12","kind":"symbol","snippet":"…",
                "llm":{ "provenance":"LLM","confidence":0.8,"purpose":"…" } } ],
  "truncated": false }
```
By default each hit carries a **lightweight LLM pointer** (5 fields, no analysis blob) — the
token-cost discipline. `withLlm:true` upgrades the pointer to the full `analysis`+`graph`+`evidence`
blob; `withLlm:false` suppresses even the pointer. `withSource`/`withRules`/`withFramework` fold the
rehydrated body / decision table+coverage / framework semantics per hit. `llmHits` are ranked by
term-overlap and de-duplicated against `hits` so they never override BM25 ranking. `truncated:true`
means more results existed beyond `limit`.

## `neighbors({op:'describes', id})`
Thin verb: just the doc-sections linked to a symbol (cheap, high value).
```jsonc
// req: { "id":"sym:…#AuthService.login@L42", "minConfidence?":0.4 }
// res: { "docs":[ { "sectionId":"…","heading":"Sessions","snippet":"…","edgeType":"describes",
//                   "provenance":"EXTRACTED","confidence":0.95 } ] }
```

## `neighbors(id, rel?)`
Raw adjacency for a node (graph walking primitive).
```jsonc
// req: { "id":"…", "rel?":"calls", "dir?":"out"|"in"|"both", "limit?":50 }
// res: { "edges":[ { "src":"…","dst":"…","rel":"calls","provenance":"EXTRACTED","confidence":1.0 } ], "truncated":false }
```

## `impact({op:'path', from, to})`
```jsonc
// req: { "from":"sym:…","to":"sym:…","maxHops?":6 }
// res: { "path":[ "sym:…","sym:…","sym:…" ], "edges":[ {…} ], "found":true }
```

## `detect_changes`
What changed since a ref (for review/impact-of-a-diff), and the pre-commit graph check.

Two path sets are reported and BOTH feed `changedSymbols`/`removedEdges`: `changedPaths` is the
commit range `since..HEAD`, `uncommittedPaths` is the working tree. The working tree is included
because this verb is called BEFORE committing — a commit range alone cannot see the very change the
caller is about to make.

`note` is present only when the report is degraded or narrowed in scope, and an empty result
carrying one is never a clean bill of health: `vcs adapter not configured`, `not a git work tree`,
`no incremental anchor — run \`crib index\` to establish one`, and `no commits since the anchor …`
(the range was empty by construction because the anchor IS the current commit).
```jsonc
// req: { "since?":"<git sha>" }                          // default: the soul's incremental anchor
// res: { "since":"<sha>", "head":"<sha>",
//        "changedPaths":["src/auth.ts"],                 // committed since the anchor
//        "uncommittedPaths":["src/token.ts"],            // still in the working tree
//        "changedSymbols":["sym:src/auth.ts#login@L4","file:src/auth.ts"],
//        "removedEdges":[ {"id":"…","src":"…","dst":"…","rel":"calls"} ],
//        "note?":"no commits since the anchor — this report covers UNCOMMITTED working-tree changes only" }
```

## `extract_rules(proc?)` *(deep-extraction)*
Flatten the CFG into a decision table — for each terminal action, the AND-chain of guards reaching
it. The migration deliverable [Q39, Q40].
```jsonc
// req: { "proc?":"sym:claims.pkb#process_claim@L10" }   // omit → whole system
// res: { "rules":[ { "action":"escalate_claim","conditions":["v_amt > 10000"],
//                    "source":"claims.pkb@L12","reads":["CLAIMS.amount"] } ] }
```

## `status({op:'gaps'})` *(missing-asset detection)*
Surface what an LLM otherwise misses by reading the graph alone: declarations without bodies,
package specs with no body file, call sites that resolve to no symbol, plus the schema-1.3
framework-semantics anomalies. Pure over the soul + index; deterministic. The migration-analyst
answer to "is the package body missing?" — the crib says so explicitly instead of letting the
analyst infer it from silence.

Five signals (each omitted when empty):
- `unimplemented` — a callable whose qualified-name group owns zero `executes` edges (a declaration
  with no body anywhere).
- `packageSpecsWithoutBody` — a `package` symbol whose member callables are ALL unimplemented AND
  none live in a body file (`.pkb`/`.pck`/`.pls`/`.pkh`).
- `unresolvedCallSites` — a recorded call site whose callee simple-name matches no symbol. Oracle
  built-in packages (`DBMS_*`/`UTL_*`/`APEX_*`/…) are flagged `builtin:true`, never silently hidden.
- `controllersWithoutRoutes` *(1.3)* — a `controller`-stereotype class whose member methods expose
  ZERO routes (a `@Controller` with no handler methods, or whose handlers all lost their
  `@GetMapping`). Members are resolved via incoming `member-of` edges.
- `unresolvedInjects` *(1.3)* — a class declares a DI type in `meta.injects` that the resolver never
  linked to a symbol (no `injects` edge from the class). The dual of unresolved call sites: a
  missing bean the consumer expects. Built-in/framework type names are flagged, not dropped.

`summary` carries a count per array plus `analysisReadiness` (`incomplete` iff any body-missing gap
exists — an unimplemented callable or a package spec with no body — else `complete`).

```jsonc
// req: { "extractedOnly?": false }
// res:
{ "unimplemented":[ { "id":"sym:…#PKG_LOAN_RULE_ENGINE.RESOLVE_AND_EVALUATE_RULES@L10",
                      "qualifiedName":"…","implemented":false,"referencedBy":["claims.pkb"] } ],
  "packageSpecsWithoutBody":[ { "id":"sym:…#PKG_LOAN_RULE_ENGINE","qualifiedName":"…",
                                "declaredCount":7,"implementedCount":0,
                                "expectedBodyFile":"pkg_loan_rule_engine.pkb",
                                "referencedBy":["claims.pkb","…"] } ],
  "unresolvedCallSites":[ { "caller":"sym:…#process_claim@L12","callerName":"…",
                            "callee":"PKG_MISSING.do_it","line":12,"builtin":false } ],
  "controllersWithoutRoutes":[ { "id":"sym:…#EmptyController","qualifiedName":"…",
                                 "memberCount":3,"routeCount":0 } ],
  "unresolvedInjects":[ { "id":"sym:…#LoanService","qualifiedName":"…","stereotype":"service",
                          "unresolved":["com.example.MissingBean"] } ],
  "summary": { "unimplemented":1, "packageSpecsWithoutBody":1, "unresolvedCallSites":1,
               "controllersWithoutRoutes":1, "unresolvedInjects":1,
               "analysisReadiness":"incomplete" } }
```

## `cypher` *(optional, index-backend-dependent)*
Raw graph query when the index backend supports it (LadybugDB). Gated by `capabilities.cypher`.
```jsonc
// req: { "query":"MATCH (a:symbol)-[:calls]->(b) WHERE a.name='login' RETURN b LIMIT 20" }
// res: { "rows":[ {…} ], "columns":["b"] }
```

---

## `enrich({op:'status'})` *(LLM graph generation queue)*
Coverage + next layer + (optionally) ranked scopes for the graphify-style picker. The MCP server
never calls a model — it exposes a deterministic work queue the host IDE's agent drives.
```jsonc
// req: { layer?, scope?:{pathPrefix,cluster}, scopes?:true, budgetTokens?:number }
// res (unscoped):
{ "model":"host-model", "builtAgainstHead":"a1b2c3",
  "layers":{ "symbol":{total,missing,stale,fresh}, "file":{…}, "cluster":{…}, "system":{…} },
  "nextLayer":"symbol", "done":false,
  "progress":{completed,pending,total}, "costEstimate":{currency:"tokens",pending,total},
  "systemSkeleton":{ "present":false, "fresh":false } }   // Phase-0.5 draft-bible signal
// req:{scopes:true} → adds { totalPending, threshold, scopes:[{pathPrefix,label,pending,symbols,files,clusters}] }
// req:{scope:{pathPrefix}} → counts/nextLayer over in-scope targets; system reported via wholeRepoPending.
```

## `enrich({op:'next'})` *(grounded work batch for the host agent model)*
Returns the next missing/stale work batch — seed facts, lower-layer analyses, output schema, and
instructions — for the host agent to author. `batchId` is deterministic over the FULL pending set
(same pending set ⇒ same id ⇒ idempotent re-calls; `zeroProgress:true` flags a re-issue with no save
landing). The system layer is never offered under a scope.
```jsonc
// req: { layer?, limit?, scope?:{pathPrefix,cluster}, budgetTokens?:number, skeleton?:boolean }
// res:
{ "batchId":"llm:symbol:8ae6aa12e1a0", "layer":"symbol",
  "items":[ { targetId, seed:{node,sourceBody,callers,callees,…}, lowerLayer, outputSchema, instructions } ],
  "remaining":12, "selectedTargetIds":[…],
  "progress":{…}, "costEstimate":{currency:"tokens",batch,perItem,totalPending} }
```
- **Queue ordering (new default):** tests LAST → importance desc (cluster = summed member importance)
  → id asc. Replaces the old alphabetical-by-id sort that surfaced `cli.test.ts` helpers first.
- **`skeleton:true` with `layer:"system"` (Phase 0.5):** returns a SINGLE draft-bible work item
  under batchId prefix `llm:system-skeleton:`, seeded from `{repo, stats, functionalMap, readmes
  (top 10 README doc-sections), topSymbols (top 50 by importance), caveats}`. A skeleton never
  satisfies the system layer — the final full pass (`llm:system:`) is still offered. Explicit-only;
  `nextLayer` never auto-chooses skeleton. Returns an empty batch once a fresh skeleton exists.

## `enrich({op:'save'})` *(persist an externally-authored batch)*
Validates + persists a batch the host agent authored. `accepted`/`rejected` per item; unresolved
graph edges are dropped with a reason. The MCP server never calls a model — it only validates,
stamps, and writes artifacts + projections + manifest + overview.

```jsonc
// req: { batchId, items:[{ targetId, model?, analysis, graph:{nodes,edges}, evidence }] }
// res: { "accepted":[{targetId,path,droppedEdges?}], "rejected":[{targetId,reason}] }
```

**Per-item validation** (rejects land in `rejected[].reason`):
- `unknown targetId` — `targetId` is not a registered soul target (wrong/renamed symbol).
- `analysis must be an object` / `graph must be an object` / `graph.nodes|edges must be an array` /
  `evidence must be an array` — shape checks.
- `graph.nodes require localId, kind, and name` — every node needs all three.
- `graph.edges require from, to, and rel` — every edge needs all three.
- `graph.edge confidence must be between 0 and 1` / `analysis confidence must be between 0 and 1`.

**Edge endpoint resolution** (`resolveEndpoint`, per `from`/`to`): the endpoint is accepted if it is
(1) a real soul node id, (2) a `localId` defined in *this* item's `graph.nodes`, (3) an LLM node id
already saved in an *earlier* item of this batch or a prior saved batch, or (4) the bare localId of
an already-saved node on this target. Otherwise the edge is **dropped** and reported in
`accepted[].droppedEdges[]` as `{ edge, reason:"unresolved endpoint" }`. Scope is **not** a write
constraint — cross-scope edges (a `packages/core` symbol calling a `packages/mcp` symbol) resolve
against the full soul, so they are kept.

**Stamping & persistence (per accepted item):**
- Each `graph.node` is stamped with `id = llmNodeId(targetId, localId)` and `targetId`; each kept
  edge is stamped with resolved `from`/`to` + `targetId`.
- Skeleton mode is stamped **server-side from the batchId prefix** — a `llm:system-skeleton:` batch
  always persists `mode:"skeleton"` (the skill can't forget); a full system save leaves `mode`
  absent (reads as `full`) and **overwrites the skeleton at the same `targetId`+`nodeHash` path**.
- `writeArtifact` writes the per-target JSON to `.crib/llm/analysis/<layer>/<hh>/<target>…json`;
  `writeGraphProjection` writes the merged projection that `neighbors({op:'llm'})` / `overview` read, so the
  new analysis is visible immediately.
- After the batch: `writeManifest(model)` and `writeOverview()` rebuild the cached manifest +
  `overview.json` (v2 gate). `model` falls back to the first item's `model` then the prior manifest
  model. The `lastIssued` zero-progress map (see `enrich({op:'next'})`) is preserved across the manifest
  rewrite.

## `overview` *(LLM codebase bible — v2, module-segmented + lean)*
v2: `modules` (always present, works at 0% enrichment), `analyses` (lean pointers, production
symbols first / test helpers last), and `system` (the freshest bible, full preferred over a draft
skeleton). The old v1 dump of every fresh artifact as a full analysis+graph+evidence blob sorted
alphabetically is gone — that surfaced test helpers first and megabytes of scaffolding before the
bible. v1 `overview.json` caches auto-rebuild via the `version === 2` gate.
```jsonc
// req: { scope?:{pathPrefix,cluster}, withLlm?:boolean }
// res:
{ "version":2, "model":…, "builtAgainstHead":…,
  "modules":[ { id, name, pathPrefix, purpose?, counts, coverage:{fresh,pending,pct}, topSymbols } ],
  "analyses":[ { layer, targetId, purpose, confidence?, stale } ],   // LEAN pointers, importance-sorted
  "system":{…LlmAnalysis}, "systemProvenance":{ mode:"full"|"skeleton", stale },   // unscoped only
  "scopeEcho?":{…} }
// withLlm:true → adds `full:[{layer,targetId,analysis,graph,evidence}]` (computed live, never cached).
// scope:{pathPrefix} → excludes the system layer; modules/analyses filtered to the scope.
```

## `neighbors({op:'llm'})` *(LLM semantic-graph walk)*
Walk the LLM semantic graph around a soul id or LLM local/global node id: rules, features, flows,
capabilities, and concepts touching it. Returns the resolved id + the touching edges.
```jsonc
// req: { id:"sym:src/auth.ts#AuthService.login@L10" }
// res: { "id":"sym:…", "edges":[ {from,to,rel,confidence?,rationale?} ] }
```

---

## Memory ledger (`memory_recall`, `memory_observe`, `memory({op})`)

Agent memory over three stores and one trust model. A claim becomes trusted by passing a declared
gate (`crib memory evaluate` / `activate` / `propose` — receipts produced by the CLI/CI runner
only; the MCP server never evaluates or executes a gate), never by an agent writing it down.

| Store | Root | Notes |
|---|---|---|
| team | `<repo>/.crib/memory/team` | committed to Git; team trust derives from exact record+decision blobs present on a trusted ref (`crib memory check` CI gate) |
| local | `~/.crib/memory/repos/<repoId>` | one repo, one machine — candidates, attempts, receipts, decisions, feedback |
| global | `~/.crib/memory/global` | **device-global, not user-global** — see below |

**Honesty note on "global":** the global store is rooted at the observing machine's home directory
until the operator configures encrypted sync. A `scopeBoundary:'global'` claim is global in
*meaning*, while cross-device placement still requires `crib memory init-sync` and CLI push/pull.

All memory verbs honour `ifHash` (a repeat echoing the prior `hash` collapses to
`{ unchanged:true, hash }`), and degrade to `{ memory:'not configured' }` when no ledger is wired.

### `memory_recall` *(compatibility adapter — one release cycle)*
Ranked, trusted-only recall across team + local + global. Never returns invalid, superseded,
retracted or quarantined records; conflicting claims come back together so the disagreement is
visible. Ranked by the pure 6-criterion comparator: lexical (a disposable in-memory FTS5 index
built per call — never mixed with the code BM25) → source tier team > local > global → evidence
quality → bounded feedback (±3). The `score` field exposes those components
(`lexical`/`sourceTier`/`evidenceQuality`/`feedbackAdjust`) — priority-ordered comparison
criteria, never a weighted sum — and every hit is version-aware: a migrated memory-2 twin answers
with its v2 fields (`schemaVersion`, `visibility`, `propositionKey`, `validTime`,
`transactionTime`, `lineage`) instead of the undefined v1 ones.

```jsonc
// req: { "q?":"parser hangs on CASE", "targetIds?":["sym:…"],
//        "sources?":["team","local","global"], "limit?":5 /* max 20 */,
//        "maxTokens?":1200, "withEvidence?":false, "includePending?":false, "ifHash?":"…" }
// res:
{ "memories":[ { "id":"mem:…","subject":"topic:plsql-parser","claim":"…","scope":{…},
                 "source":"team","trust":"team","evidence":"valid","applicability":"current",
                 "lifecycle":"active","appliesTo":[…],"createdAt":"…",
                 "score":{ "lexical":1000002,"sourceTier":3,"evidenceQuality":2,"feedbackAdjust":0 },
                 "evidenceItems":[ { "kind":"source-quote","verdict":"valid","soulId":"sym:…" } ] } ],
  "conflicts":[ { "key":"<subject>|<boundary>|<repoId>","subject":"…","scope":{…},
                 "recordIds":["mem:…","mem:…"] } ],
  "provenance": { "sources":[…], "counts": { "team":3,"local":12,"global":1,
                  "considered":16,"eligible":9,"conflicts":1 }, "fresh":true },
  "truncated":false }
// includePending:true → adds a SEPARATE "pending":[ { "id":"cand:…","kind":"fact","subject":"…",
//   "claim":"…","actor":"…","trust":"untrusted","status":"pending" } ] group — the shared working
//   set of in-flight observations from other agents on this repo. Never merged into "memories".
// token budget exhausted → "budgetExhausted":true
```

### `memory_observe` *(compatibility adapter — one release cycle)*
Stage a fully-formed LOCAL candidate — content-addressed, so re-observing the same claim upserts
the same `cand:` id. Promotion is a separate CLI/CI step. A repo-scoped observation needs a stable
repoId (`crib index`) and is refused without one, rather than written with an id that would be
unstable across machines. Response vocabulary convention: the status is reported as `'pending'`,
never with other trust-tier words — some installed client hooks reject those tokens. G2.2: the
staging runs the same unified funnel as `memory({op:'capture'})` — a capture-policy gate first
(typed `violations` on a refusal, nothing written), then the durable `cap:` outbox entry, then the
staging entry — so a crash before the staging write replays at-least-once.

```jsonc
// req: { "kind":"pitfall","subject":"topic:plsql-parser","claim":"…",
//        "appliesTo?":[…],"evidence?":[…],"actor":"claude","authorKind?":"agent",
//        "tool?":"memory_observe","scopeBoundary?":"repo","attemptId?":"att:…",
//        "idempotencyKey?":"…","ifHash?":"…" }
// res (refused): { "ok":false,"error":"capture refused by policy — fix the input or adjust the
//                        capture policy","violations":[{"axis":"secret","reason":"…"}] }
// res (accepted): { "ok":true,"id":"cand:…","status":"pending","origin":"observe",
//                   "scope":{ "boundary":"repo","repoId":"…" },
//                   "outboxId":"cap:…","idempotent":false }
```

### Intake continuation operations

The consolidated `memory` tool exposes `intake_create`, `intake_checkpoint`, `intake_list`,
`intake_get`, and `intake_share`. Requirements and checkpoints are immutable, content-addressed,
secret-scanned local entries; `handoff` projects them into a resume brief with one primary only
when exactly one intake remains resumable. A non-terminal checkpoint requires `nextSafeAction`.

```jsonc
// create
{ "op":"intake_create", "original":"Finish migration", "outcome":"Migration complete",
  "scope":["packages/memory"], "acceptanceCriteria":["Tests pass"], "actor":"human:user" }
// checkpoint
{ "op":"intake_checkpoint", "id":"intake:…", "phase":"executing",
  "summary":"Sync landed", "nextSafeAction":"Run integration tests", "actor":"agent:codex" }
// restore
{ "op":"handoff" }
// device audience only; team promotion deliberately requires the CLI
{ "op":"intake_share", "id":"intake:…", "audience":"devices", "actor":"human:user" }
```

MCP device sharing writes the local audience checkpoint and reports `sync:"staged-local-only"`;
the next configured CLI push transfers it. Team sharing returns `status:"cli-required"` because
Git-visible promotion is an explicit operator action: `crib intake share <id> --audience team`.

### `memory({op:'get'})`
One record by id — resolved through the portable memory API: a DIRECT hit wins in each store
(local `active`, then team `records`, then global `records`), and a legacy v1 id whose record was
migrated to memory-2 follows the alias map to its twin (reports `resolvedViaAlias`). The response
is version-aware: a memory-1 record answers with the v1 fields (`scope`, `appliesTo`, `authorship`,
`createdAt`, stamped `verdicts`), plus `supersededBy` ONLY when a supersession exists (a
`supersede` decision naming it, or another record's `lineage.supersedes` declaring it) so the
classic no-successor response stays byte-identical to the original W3 contract; a memory-2 record
answers with its v2 fields instead —
`schemaVersion:"2"`, `visibility`, `propositionKey`, `validity` (bi-temporal `validTime` +
`transactionTime`), `lineage`, `provenance`, effective (alias-restored) `verdicts`, `placement`,
`legacyIds` and `supersededBy` — never the undefined v1 fields the v2 envelope no longer carries.
Evidence is summarised (kind + verdict + soul anchor) unless `withEvidence:true`.
```jsonc
// req: { "id":"mem:…", "withEvidence?":false, "ifHash?":"…" }
// res (memory-1): { "id":"mem:…","subject":"…","claim":"…","scope":{…},"appliesTo":[…],
//                   "authorship":{…},
//                   "verdicts":{ "trust":"team","evidence":"valid","applicability":"current",
//                                "lifecycle":"active" },
//                   "source":"team","createdAt":"…","evidence":[…] }
// res (memory-2, incl. via a legacy id): { "id":"mem:…","requestedId":"mem:legacy…",
//                   "resolvedViaAlias":"mem:legacy…","schemaVersion":"2","kind":"fact",
//                   "subject":"…","claim":"…","visibility":"workspace","propositionKey":"…",
//                   "sensitivity":"internal","retentionPolicyId":"ret:default","provenance":{…},
//                   "validity":{ "validTime":{…},"transactionTime":{…} },"lineage":{…},
//                   "verdicts":{…},"source":"team","placement":["team"],"legacyIds":[…],
//                   "supersededBy":[],"evidence":[…] }
// unknown id → { "found":false, "id":"mem:…" }
```

### `memory({op:'search'})`
Ranked search over the whole ledger — the SAME recall projection `memory_recall` uses (the
6-criterion priority-ordered ranking, alias bridging, conflict grouping and the hard eligibility
filter), delegated to the portable memory API with the same lexical signal, so the two read verbs
can never disagree about rank. Each hit enriches the recall view with the G1.3 contract: effective
(alias-restored) verdicts, evidence summaries, `freshness`, `validity`, `lineage`, `placement`,
`score` + `rankingVersion`, the conflict groups the hit participates in, and `supersededBy`.
`limit` defaults to 5 (max 20); `maxTokens` (default 2000) trims within the limited set
(`truncated:true` when either cut applied). `q` is optional — an absent query degrades to
`targetIds`-only matching, exactly like `memory_recall`.
```jsonc
// req: { "q?":"loan threshold", "targetIds?":["sym:…"], "sources?":["team","local"],
//        "limit?":5, "maxTokens?":2000, "withEvidence?":false, "ifHash?":"…" }
// res: { "query":"loan threshold",
//        "hits":[ { "id":"mem:…","schemaVersion":"2","subject":"…","claim":"…","source":"team",
//                   "trust":"team","evidence":"valid","applicability":"current","lifecycle":"active",
//                   "verdicts":{…},
//                   "score":{…},"visibility":"workspace","propositionKey":"…","placement":["team"],
//                   "lineage":{…},"freshness":{ "state":"fresh","evaluatedAt":null,"codeHead":null },
//                   "validity":{…},"rankingVersion":"recall-v1:priority-order",
//                   "conflicts":[…],"supersededBy":[],"evidenceItems":[…] } ],
//        "conflicts":[…], "provenance":{ "rankingVersion":"recall-v1:priority-order","sources":[…],
//                                       "counts":{…},"fresh":true,"evaluatedAt":null,"codeHead":null,
//                                       "errors":[] },
//        "truncated":false }
```
`hit.source` is the EFFECTIVE store the projection resolved the hit from (the store whose verdict
overlay governs) — the same per-source field `memory_recall` reports. It is NOT `placement[0]`:
`placement` is storage-only and local-first, and a record placed in both local and team yields TWO
hits (one per source). `freshness.state` carries the freshness signal; `evaluatedAt` is always
`null` — no wall clock enters the response, so two identical searches are byte-equal and `ifHash`
collapses the repeat (determinism invariant). `supersededBy` is scoped to the hit's source the
same way the verdict overlay is (the no-poison rule): a LOCAL `supersede` decision retires the
local-sourced copy only, so a team-sourced hit never lists a successor the team store never
accepted — the successor list can never contradict the hit's own lifecycle.

### `memory({op:'supersede'})`
Retire a record in favour of a successor — the record line is never rewritten (memory is
append-only): the lifecycle change is a `supersede` decision appended to the store that holds the
record, and history/audit keep the full trail. `successor` names an EXISTING record; `claim`
(+ optional `subject`/`kind`/`visibility`/`propositionKey`) writes a NEW memory-2 successor
carrying `lineage.supersedes`. Idempotent: the decision — and a payload successor — are
content-addressed, so a repeat call is a byte-stable no-op. Legacy ids resolve through the alias
map, so a pre-migration id retires its migrated twin.
```jsonc
// req: { "id":"mem:…", "successor?":"mem:…", "claim?":"the corrected claim", "subject?":"topic:…",
//        "kind?":"fact", "visibility?":"private", "propositionKey?":"…", "actor":"claude",
//        "reason?":"claim was wrong after the fix", "tool?":"…", "ifHash?":"…" }
// res: { "ok":true,"supersededId":"mem:…","successorId":"mem:…","decisionId":"dec:…",
//        "successorCreated":true,"decisionSource":"team" }
// res (error): { "ok":false,"error":"record 'mem:…' not found in any store" }
```

### `memory({op:'delete'})`
A tombstone, never a removal — appends a `retract` decision (the record line stays; search
excludes the record while `history`/`audit` still see it). Legacy ids resolve through the alias map.
```jsonc
// req: { "id":"mem:…", "actor":"claude", "reason?":"…", "ifHash?":"…" }
// res: { "ok":true,"id":"mem:…","decisionId":"dec:…","mode":"tombstone","decisionSource":"team" }
```

### `memory({op:'history'})`
The bi-temporal belief timeline for one key (a record id, a legacy id, a subject, or a proposition
key). Without `asOf` the full timeline; with `asOf` a point-in-time read projection — only records
recorded ≤ `asOf` and decision events with `ts` ≤ `asOf` overlay: what was BELIEVED then, never a
rewrite of the store. With `asOf`, each record also reports `validTimeHolds` — whether its
validTime window covers the instant (half-open `[from, to)`: `at === to` is outside; the claim
stopped holding) — so the two time axes stay separate: `transactionTime` decides whether the store
KNEW the record at `asOf`, `validTime` whether the claim was TRUE then. With `asOf`, each record
also reports `validTimeWindow` — the window's SHAPE (`valid` / `inverted` / `unparseable`) — so a
`validTimeHolds:false` hit is distinguishable as mere non-coverage (`valid`) versus a broken
window, instead of failing silently. A memory-1 record carries
no bi-temporal fields, so its `validity` derives both axes from `createdAt` — the same mapping the
migration stamps, never a fabrication. A migrated local/global twin answers with its `legacy`
block: the local/global migration REPLACES the v1 line with the twin, and the alias binding is the
only place the as-believed v1 state (placement scope, `appliesTo`, open `meta`, stamped verdicts)
survives — history reads it back. `asOf` is parsed once as an ISO instant — date-only and
`±HH:MM` offset forms resolve to their canonical instant, and an UNPARSEABLE `asOf` is rejected
(`{ ok:false, error }` over MCP, exit 2 + stderr on the CLI), never a silently mis-filtered
timeline. The derived `lifecycle`/`quarantined` belief fields honour the same no-poison rule as
`memory_get` (a LOCAL decision never rewrites a team-sourced record's belief) and fold from the
record's STAMPED lifecycle (v1 `verdicts.lifecycle`, the v2 conservative alias snapshot — the
same base the effective verdicts use), so a hand-edited shard projects ONE lifecycle across
get/audit/history; the raw `events` list keeps every recorded decision, tagged with its store.
```jsonc
// req: { "key":"mem:…", "asOf?":"2026-08-12T00:00:00.000Z", "withEvidence?":false, "ifHash?":"…" }
// res: { "key":"mem:…", "asOf":"2026-08-12T00:00:00.000Z",
//        "records":[ { "id":"mem:…","schemaVersion":"2","subject":"…","claim":"…",
//                      "recordedAt":"…","validTime":{…},"lifecycle":"superseded","quarantined":false,
//                      "validTimeHolds":true,"validTimeWindow":"valid","placement":["team"],
//                      "legacy":[…],"evidence":[…] } ],
//        "events":[ { "at":"…","type":"recorded","recordId":"mem:…","source":"team","validTime":{…} },
//                   { "at":"…","type":"supersede","recordId":"mem:…","source":"team","actor":"claude",
//                     "successor":"mem:…" } ] }
```

### `memory({op:'sync'})`
Read-only status for the configured encrypted sync engine. Push and pull are deliberately refused
over MCP so an agent session cannot cause network writes; operators use
`crib memory sync push|pull` from the CLI.
```jsonc
// req: { "request?":"status", "ifHash?":"…" }
// res: { "available":true, "stores":[…] }
// request:"push" | "pull" → { "ok":false, "status":"cli-required", "message":"…" }
```

### `memory({op:'outbox'})`
The capture-outbox drain surface (G2.3). Read-only reporting of the LOCAL queue that
`memory{op:'capture'}` / `memory_observe` stage (`cap:` entries, written BEFORE their staging
candidate so a crash is recoverable at-least-once): pending / done / dead counts, the pending
captures (each with its retry count — the distiller's failure count so far), and drained entries
with their distill decision, rationale, and `verified` flag. The drain itself is the CLI's
`crib memory distill --provider <name>`: it hands each pending capture to an external provider from
`~/.crib/providers.json` (the enrich-provider mechanism — spawn `shell:false`, strict JSON, per-item
timeout), and the provider's ADD / SUPERSEDE / CONFLICT / NOOP decision is applied ONLY after crib
verifies it deterministically (an uncited SUPERSEDE/CONFLICT/NOOP, a CONFLICT across proposition
keys, or a CONFLICT whose claims are not deterministic negations is a per-item failure: a retry
append, dead-lettered at the third attempt). Complementary same-subject claims classify as ADD,
never CONFLICT — the pinned red line. The outbox is local-only (no-poison), so this reads the local
store and degrades to `not configured` without one.
```jsonc
// req: { "ifHash?":"…" }
// res: { "counts": { "pending":2,"done":5,"dead":1 },
//        "pending": [ { "id":"cap:…","kind":"pitfall","subject":"topic:deploy",
//                       "claim":"…","origin":"observe","proposedAt":"…","retries":1,
//                       "sessionId":"…","sessionOffset":3,"eventOffset":7 } ],
//        "done":   [ { "id":"cap:…","kind":"fact","proposedAt":"…","candidateId":"cand:…",
//                      "decision":"ADD","rationale":"…","verified":true } ],
//        "dead":   [ { "id":"cap:…","reason":"unsupported SUPERSEDE: no local record 'mem:…'" } ] }
```

### `memory({op:'status'})`
Ledger tallies by trust / evidence / applicability / lifecycle / source, plus `eligible`
(recall-eligible), `quarantined`, and `pending` (local candidates not yet promoted).
`provenance.fresh:true` means the counts reflect a live revalidation against the soul.
```jsonc
// req: { "ifHash?":"…" }
// res: { "counts": { "total":16,"eligible":9,"quarantined":1,"pending":4,
//                    "trust":{…},"evidence":{…},"applicability":{…},"lifecycle":{…},"source":{…} },
//        "provenance": { "fresh":true, "errors":[] } }
```

### `memory({op:'audit'})`
Read-only health report — never mutates a record, decision, or store. `validation.drift` lists
records whose fresh evidence/applicability verdict differs from the stamped one (content drifted
since the record was saved); `privacy` re-runs the write-time secret scan on every record (the
store guarantees 0 on write — audit confirms nothing slipped in via a raw shard edit);
`contradictedForReview` lists records contradicted WITHOUT admissible counter-evidence (bounded
penalty applied, awaiting review) while `quarantined` counts already-suppressed ones. The
no-poison rule throughout: a quarantine decision is written to the LOCAL `decisions` collection
only — one local negative event can never retract team memory. Verdict axes are version-aware: a
memory-2 record carries no `verdicts` of its own — its stamped axes ARE the alias snapshot (worst
axis across every collapsed sibling), so a migrated record tallies with the trust it had before
migration and status/audit agree with recall instead of silently demoting it to `candidate`.
(Scope note: this MCP verb audits the whole three-store ledger; the CLI `crib memory audit`
tallies its trust distribution over TEAM records only — a pre-existing CLI scope, not a
disagreement about the data.)
```jsonc
// req: { "ifHash?":"…" }
// res:
{ "validation": { "records":16, "drifted":1,
                  "drift":[ { "id":"mem:…",
                              "stamped":{ "evidence":"valid","applicability":"current" },
                              "fresh":{ "evidence":"degraded","applicability":"current" } } ] },
  "conflicts":[ { …same conflict view as memory_recall… } ],
  "privacy": { "secretsScannedOnWrite":true, "secretsFlagged":0 },
  "trust": { "team":3, "local":12, "global":1 },
  "feedback": { "quarantined":1,
                 "contradictedForReview":[ { "subject":"mem:…","actor":"…","ts":"…" } ] },
  "provenance": { "fresh":true, "errors":[] } }
```

### `memory({op:'capture'})`
Episodic capture to the candidate tier — the loose one-shot counterpart to `memory_observe`'s
disciplined path (subject + observation, optional files/symbols, written straight to the
pending tier, never directly to a trusted store). What makes a capture checkable is the
auto-anchor: loose `symbols`/`files` refs are resolved to soul ids, and the first resolvable
spanned symbol backs a `source-quote` evidence item lifted verbatim from the rehydrated span and
self-checked with the same grounding gate the enrich path uses before its `valid` stamp — the
stamp is earned, not assumed. Anchoring never fails the capture; the result reports
`anchorStatus` (`anchored` / `ambiguous` / `unresolvable` / `unanchored`) so the caller knows
exactly how checkable the candidate is. Content-addressed like `memory_observe`, so a repeat
capture of the same observation upserts to the same id. G2.2: a capture-policy gate runs BEFORE
anything is written (secrets / PII / home-path / transcript hygiene always on; `maxClaimChars` /
`forbiddenKinds` / `allowedScopeBoundaries` tighten via `policy.json`'s `capture` section), and the
durable `cap:` outbox entry lands BEFORE the staging entry (`outboxId` + `idempotent` ack) — the
same funnel observe uses.
```jsonc
// req: { "subject":"topic:plsql-parser", "observation":"parseFile hung on a stray WHEN …",
//        "kind?":"fact", "files?":[…], "symbols?":["recover"], "actor":"claude",
//        "tool?":"memory", "scopeBoundary?":"repo", "idempotencyKey?":"…",
//        "sessionId?":"…","sessionOffset?":0,"eventOffset?":0, "ifHash?":"…" }
// res (refused): { "ok":false,"error":"capture refused by policy — fix the input or adjust the
//                        capture policy","violations":[{"axis":"path","reason":"…"}] }
// res (accepted): { "ok":true,"id":"cand:…","status":"pending","origin":"observe","scope":{…},
//                   "anchorStatus":"anchored","evidenceAttached":true,"anchors":["sym:…"],
//                   "outboxId":"cap:…","idempotent":false }
```

### `memory({op:'feedback'})`
Record a LOCAL feedback signal on a record (`useful` / `unhelpful` / `contradicted`),
content-addressed so a repeat signal upserts the same `fb:` id. A `contradicted` signal quarantines
(LOCAL only) only when backed by admissible counter-evidence — an item whose kind is admissible
for the record's claim kind AND whose verdict is `valid`; otherwise the record keeps a bounded
ranking penalty and is surfaced for review in `memory({op:'audit'})`.
```jsonc
// req: { "subject":"mem:…", "signal":"contradicted", "actor":"claude", "context?":"…",
//        "counterEvidence?":[ { "kind":"execution-assertion","verdict":"valid",…} ], "ifHash?":"…" }
// res (suppressed): { "ok":true,"feedbackId":"fb:…","suppressed":true,
//                     "quarantineDecisionId":"dec:…","subject":"mem:…",
//                     "note":"contradicted by admissible counter-evidence — record quarantined
//                            locally (team memory untouched)" }
// res (not suppressed): { "ok":true,"feedbackId":"fb:…","suppressed":false,
//                         "surfacedForReview":true,"subject":"mem:…","note":"…" }
```

The portable-API op set (`search` / `supersede` / `delete` / `history` / `sync`) IS in the
capability manifest as of Gate 1.3 — each is a one-line manifest entry (see the consolidation
note at the top) routed to the portable `MemoryApi` in `packages/memory/src/api.ts`, and the
`memory({op:'get'})` / `memory({op:'capture'})` verbs delegate to the same API (get resolves
aliases and answers version-aware; capture keeps its exact W3 response contract plus the additive
G2.2 ack fields — `ok`, `outboxId`, `idempotent`, and the typed `violations` array on a policy
refusal). `memory_recall`
and `memory_observe` remain as compatibility adapters — they are the two verbs the installed
client protocol names directly — and retire one release cycle after their replacements are rolled
out to the installed instructions.

### The memory-2 record envelope (schema version 2)

Memory-1 is the live OBSERVATION format today (`memory_observe` and `memory({op:'capture'})`
stage memory-1 candidates); the memory-2 envelope is implemented at the storage layer (vendored
`record-v2` schema, shared-prefix validation, store write/read, loader, migrator, and the
legacy-ID alias map) and the loaders accept both versions side by side. Memory-2 records are
WRITTEN by `MemoryStore.migrateToV2` (the explicit store rewrite pass) and by
`memory({op:'supersede'})` when it authors a new successor claim; every read verb is version-aware
(get/search/status/audit/history all resolve aliases and project v2 fields instead of undefined v1
ones). The envelope fixes the memory-1 deficiencies Gate 1 named — visibility-vs-placement,
conflict keying, bi-temporal time — plus the structural additions the review hardening landed:

- **Visibility ≠ storage placement.** `visibility: 'private' | 'workspace'` is the record's
  semantic scope; where the bytes live (local machine, committed team store, future encrypted
  sync storage) is independent — a private memory may exist locally AND in sync storage without
  changing meaning. Memory-1 conflated the two in `scope`.
- **Conflict keyed by what the claim is ABOUT.** `propositionKey` (derived from the normalized
  subject, or pinned explicitly) is the real conflict key, and a conflict requires an explicit
  `lineage.contradicts` edge within the same propositionKey — mutually exclusive claims. Two
  complementary facts sharing a subject coexist and are NOT a conflict. Memory-1's conflict key
  was subject + scope, which over-flagged complementary facts.
- **Bi-temporal time.** `validTime` (when the claim held in the world: `from`, exclusive `to?`
  absent = still true) vs `transactionTime` (when the store learned it: `observedAt`,
  `recordedAt`) makes "what did we believe, and when" — e.g. what was true on 12 August —
  answerable without deleting history: `memory({op:'history'})` with `asOf` is the read path that
  answers it. Supersede is lineage (`lineage.supersedes`), not
  destruction.
- **Provenance, never access boundaries.** `provenance.principalId` is OWNERSHIP;
  `agentId` / `clientId` / `sessionId` / `tool` are provenance only — no access decision may
  derive from them (a session id must never become a security boundary). Tenancy fields are
  deliberately absent (local-first) because until cross-device sync ships, the global store is
  device-global, not user-global.
- **Content ids + the mandatory alias map.** A v2 record's `mem:` id seeds
  kind/subject/propositionKey/claim/evidence only — time, provenance, visibility and lineage are
  excluded so the same claim observed by two writers collapses to one id (cross-writer dedupe).
  Because the v2 seed differs from the v1 seed by design, the migration persists a legacy-ID
  alias map (`alias:` entries binding `legacyId → resolvedId`, carrying the v1 stamped verdicts
  plus the v1 placement scope, `appliesTo` and open `meta` the closed v2 envelope has no
  counterpart for) so pre-migration decisions, feedback, supersede links and candidate→record
  promotions keep resolving — the map is load-bearing, not cosmetic. For a local/global migration,
  which REPLACES the v1 line with the twin, the binding is also the only place the as-believed v1
  state survives; `memory({op:'history'})` reads it back. Read paths bridge aliases automatically:
  a migrated v2 record joins recall through its alias verdict snapshot, and because two v1 records
  of one claim (observed by two actors, or at two scope boundaries) legitimately migrate to the
  SAME twin, the snapshot merges every collapsed sibling CONSERVATIVELY — worst axis per verdict
  dimension, never a last-wins pick — and decisions keyed on ANY bound legacy id bridge onto the
  record, so a quarantine recorded against either sibling still attaches. A v2 record with no
  alias reads as candidate-trust (rank-ineligible) while remaining conflict-visible.
- **Handling fields.** `sensitivity` (`public|internal|confidential|restricted`) and
  `retentionPolicyId` classify the record for downstream handling (sync gating, redaction,
  retention) without touching meaning.

---

## Token-budget rules (cross-cutting)
- Default `docLimit=3`, `limit=10`; results ranked by confidence/score.
- `snippet` is a single short span, not full text (rehydrate full via the file if needed).
- `truncated:true` + a `more`/`cursor` hint lets the agent pull more deliberately — never dump the graph.
