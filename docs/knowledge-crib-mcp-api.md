# Knowledge-crib — MCP API Spec

> The product surface [Q22, Q33]. One MCP server over stdio (`npx knowledge-crib serve`), unified
> verb namespace, resolves `.crib/` from the repo root → serves **that project's** soul. Reads the
> `IndexStore` (fast), falls back to `SoulStore`. All payloads are **token-bounded + provenance-tagged**.

---

## Conventions
- Transport: MCP stdio. Each verb = an MCP tool.
- IDs follow the [data-model](knowledge-crib-data-model.md) grammar.
- All list responses support `limit` (default per verb) and return `truncated: boolean` + `cursor?`.
- Every edge-bearing result carries `{method, provenance, confidence, evidence}` so agents can filter to `EXTRACTED`-only.
- Errors: `{ error: { code, message, detail? } }`, codes: `NOT_INDEXED | NOT_FOUND | AMBIGUOUS | BAD_ARGS | INTERNAL`.
- **Enrichment via host LLM:** for optional enrichment (cluster naming, NL→query) the server uses MCP `sampling` — the IDE's own model [Q18]. Requires client sampling support; degrades gracefully (skipped) if absent. **Never used on deterministic verbs** (`context`/`impact`/`query`/`neighbors`/`shortest_path`).

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
surface as `⚠ unresolved` entries (parity with `gaps`).

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

## `describes(symbol)`
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

## `shortest_path(from, to)`
```jsonc
// req: { "from":"sym:…","to":"sym:…","maxHops?":6 }
// res: { "path":[ "sym:…","sym:…","sym:…" ], "edges":[ {…} ], "found":true }
```

## `detect_changes`
What changed since a ref (for review/impact-of-a-diff).
```jsonc
// req: { "since":"<git sha>" }
// res: { "changedSymbols":[ {"id":"…","change":"modified"} ], "newEdges":[…], "removedEdges":[…] }
```

## `extract_rules(proc?)` *(deep-extraction)*
Flatten the CFG into a decision table — for each terminal action, the AND-chain of guards reaching
it. The migration deliverable [Q39, Q40].
```jsonc
// req: { "proc?":"sym:claims.pkb#process_claim@L10" }   // omit → whole system
// res: { "rules":[ { "action":"escalate_claim","conditions":["v_amt > 10000"],
//                    "source":"claims.pkb@L12","reads":["CLAIMS.amount"] } ] }
```

## `gaps` *(missing-asset detection)*
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

## Token-budget rules (cross-cutting)
- Default `docLimit=3`, `limit=10`; results ranked by confidence/score.
- `snippet` is a single short span, not full text (rehydrate full via the file if needed).
- `truncated:true` + a `more`/`cursor` hint lets the agent pull more deliberately — never dump the graph.
