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
{ "indexed": true, "schemaVersion":"1.0", "stats":{"nodes":12044,"edges":31188,"clusters":37},
  "vcsHead":"a1b2c3", "incrementalSince":"a1b2c3", "capabilities":{"embeddings":false} }
```

## `index`
Full index of the current repo (writes soul + builds index).
```jsonc
// req: { "path":".", "include?":["src/**"], "exclude?":["**/*.test.ts"], "withEmbeddings?":false }
// res: { "ok":true, "stats":{...}, "durationMs": 18230 }
```

## `update`
Incremental update from changed files.
```jsonc
// req: { "since?":"<git sha>" }   // defaults to manifest.incrementalSince
// res: { "ok":true, "changedFiles":7, "chunksRewritten":9, "stats":{...} }
```

## `context(symbol)`
360° context for one symbol: signature, neighbors, cluster, and **linked docs**.
```jsonc
// req: { "id":"sym:src/auth/AuthService.ts#AuthService.login@L42", "docLimit?":3 }
// res:
{ "node": { "id":"…","name":"login","signature":"…","file":"…","span":{…},"clusterId":"c:auth" },
  "callers":  [ { "id":"…","name":"handleLogin","confidence":1.0 } ],
  "callees":  [ { "id":"…","name":"TokenService.issue","confidence":1.0 } ],
  "docs": [ { "sectionId":"doc:docs/auth.md#sessions","heading":"Sessions","anchor":"sessions",
              "snippet":"`AuthService.login` issues…","edgeType":"describes",
              "method":"explicit","provenance":"EXTRACTED","confidence":0.95 } ],
  "truncated": false }
```

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
Hybrid BM25 + semantic search over code + docs, process-grouped.
```jsonc
// req: { "q":"where is the session token issued?", "kinds?":["symbol","doc-section"], "limit?":10,
//        "extractedOnly?":false }
// res:
{ "hits":[ { "id":"sym:…#TokenService.issue@L88","kind":"symbol","score":0.81,
             "snippet":"issue(userId):Session","clusterId":"c:auth" } ],
  "groups":[ { "clusterId":"c:auth","label":"Authentication","hitIds":["…"] } ],
  "truncated": false }
```

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
