# Knowledge-crib — Data Model / Ontology

> The graph schema shared by soul, index, MCP, and `soul-reader`. Frozen at `schemaVersion`. The
> canonical machine form is JSON Schema in `packages/soul-schema`; this doc is the human spec.
> Storage encoding is in [soul-format](knowledge-crib-soul-format.md).

---

## 1. Node kinds
| `kind` | Represents | Key fields |
|--------|-----------|-----------|
| `file` | a source/doc file | `id, path, lang, hash` |
| `symbol` | code symbol (class/fn/method/interface/enum/var) | `id, type, name, qualifiedName, file, span, lang, signature, hash` |
| `doc-section` | a heading-delimited doc chunk | `id, file, heading, level, anchor, span, hash` |
| `media-seg` *(v2)* | a transcript/image segment | `id, file, span(tStart,tEnd), hash` |
| `explanation` | a docstring/comment captured as a concept | `id, file, span, text-ref, hash` |
| `cluster` | a community (functional area) | `id, label, members[]` |
| `table` *(deep-extraction)* | a DB table | `id, name, schema` |
| `column` *(deep-extraction)* | a column | `id, table, name, dataType` |
| `statement` *(deep-extraction)* | a SQL DML statement | `id, sqlKind, file, span` |
| `condition` *(deep-extraction)* | a guard/branch predicate | `id, expr, branch, file, span` |

Common to all: `id` (stable), `kind`, `hash` (blake3 of content), `meta` (extensible, round-trip-preserved).
**Text is referenced by `file` + `span`, never copied** (lean soul; rehydrate on demand).

### Node example
```json
{ "id":"sym:src/auth/AuthService.ts#AuthService.login@L42","kind":"symbol","type":"method",
  "name":"login","qualifiedName":"AuthService.login","file":"src/auth/AuthService.ts",
  "span":{"start":42,"end":58},"lang":"typescript",
  "signature":"login(email:string,pw:string):Promise<Session>","clusterId":"c:auth","hash":"blake3:9f2c…" }
```

## 2. Edge relations (`rel`)
| `rel` | Meaning | Typical `method` | `provenance` |
|-------|---------|------------------|--------------|
| `calls` | A invokes B | static | EXTRACTED |
| `imports` | file/module imports symbol | static | EXTRACTED |
| `inherits` | class extends class | static | EXTRACTED |
| `implements` | class implements interface | static | EXTRACTED |
| `describes` | doc-section is *about* a symbol | explicit / identifier | EXTRACTED (or INFERRED if semantic) |
| `references` | weaker mention of a symbol | identifier / path / semantic | EXTRACTED / INFERRED |
| `derived-from` | node produced/enriched from another | — | EXTRACTED / INFERRED |
| `member-of` | symbol belongs to file/class; node to cluster | static | EXTRACTED |
| `executes` | symbol → statement (runs SQL) | static | EXTRACTED |
| `reads` | symbol/statement → table/column | static | EXTRACTED |
| `writes` | symbol/statement → table/column | static | EXTRACTED |
| `guarded-by` | call/statement → condition (runs only if) | static | EXTRACTED |

> Deep-extraction also adds `guard` / `cfgPath` / `branch` metadata on `calls`/`executes` edges (the
> rule's guard chain) — see [deep-extraction](knowledge-crib-deep-extraction.md) [Q40].

### Edge fields
| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `e:` + blake3(`src|dst|rel`) |
| `src`,`dst` | node id | per ID grammar (§4) |
| `rel` | enum | table above |
| `method` | enum | `static \| explicit \| identifier \| path \| semantic \| inferred` — **how** derived |
| `provenance` | enum | `EXTRACTED` (deterministic) \| `INFERRED` (LLM/heuristic) [Q35] |
| `confidence` | 0..1 | |
| `evidence` | obj | `{ snippet, by }` — provenance for trust/UI |
| `meta` | obj | extensible |

### Edge example
```json
{ "id":"e:7b1f…","src":"doc:docs/auth.md#sessions","dst":"sym:src/auth/AuthService.ts#AuthService.login@L42",
  "rel":"describes","method":"explicit","provenance":"EXTRACTED","confidence":0.95,
  "evidence":{"snippet":"`AuthService.login` issues a session…","by":"md-coderef-linker"} }
```

## 3. Enumerations
- **`method`** (how an edge was derived; also drives ranking): `static` > `explicit` > `identifier` > `path` > `semantic` > `inferred`.
- **`provenance`**: `EXTRACTED` (deterministic, trustable) | `INFERRED` (LLM/heuristic, filterable out).
- **conflict rule** (same `src,dst,rel`): EXTRACTED beats INFERRED; then higher `confidence`; loser dropped if `confidence < link-threshold` (default 0.4). Same rule = git merge-driver logic.

## 4. ID grammar (stable, deterministic — critical for diffs + cross-tool refs + SeeroFlow)
| kind | id |
|------|----|
| file | `file:<path>` |
| symbol | `sym:<path>#<qualifiedName>@L<startLine>` |
| doc-section | `doc:<path>#<anchor>` |
| media-seg | `media:<path>#<tStartMs>` |
| explanation | `expl:<path>@L<startLine>` |
| cluster | `c:<slug>` |
| edge | `e:<blake3(src|dst|rel)>` |

IDs must be reproducible across runs given unchanged source → stable git diffs and durable external references.

## 5. Invariants (enforced by `core`, tested in M0)
1. Every edge `src`/`dst` resolves to an existing node (no dangling refs after a build).
2. `id` is unique per node; `(src,dst,rel)` collapses per the conflict rule.
3. `hash` changes iff node content changes (drives incremental updates).
4. `kind`/`rel`/`method`/`provenance` are closed enums (unknown → validation error).
5. Unknown `meta` keys are preserved on read→write (forward-compat).

## 6. Versioning
`schemaVersion` in the manifest. Additive fields are backward-compatible; breaking changes bump the
major and require `crib migrate`. JSON Schema is vendored under `.crib/schema/` so the soul is
self-describing.
