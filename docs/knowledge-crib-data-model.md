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
| `media-seg` *(v2)* | a transcript/image segment | `id, file, span(tStart,tEnd; page for pdf/ocr), hash` + meta: `text, modality, lang?, confidence, extractor, extractedBy, unavailable?` (G5.3 provenance — every derived node names its engine, version, and measured confidence) |
| `explanation` | a docstring/comment captured as a concept | `id, file, span, text-ref, hash` |
| `cluster` | a community (functional area) | `id, label, members[]` |
| `table` *(deep-extraction)* | a DB table | `id, name, schema` |
| `column` *(deep-extraction)* | a column | `id, table, name, dataType` |
| `statement` *(deep-extraction)* | a SQL DML statement | `id, sqlKind, file, span` |
| `condition` *(deep-extraction)* | a guard/branch predicate | `id, expr, branch, file, span` |
| `exception-handler` *(1.2)* | a `try`/`catch` handler | `id, file, span` (id: `exc:<file>@L<line>`) |
| `raise` *(1.2)* | a thrown error | `id, errorCode, errorMessage, file, span` (id: `raise:<file>@L<line>`) |
| `cursor` *(1.2)* | an explicit cursor/iterator | `id, name, cursorQuery, file, span` (id: `cursor:<file>#<name>@L<line>`) |
| `assignment` *(1.2)* | an assignment statement | `id, assignTarget, file, span` (id: `assign:<file>@L<line>`) |
| `case-branch` *(1.2)* | a `case`/`when` branch | `id, whenSelector, file, span` (id: `case:<file>@L<line>`) |
| `route` *(1.3)* | an HTTP endpoint | `id, httpMethod, routePath, framework, file, span` (id: `route:<verb> <path>@<file>#L<line>`) |
| `field` *(1.3)* | a class/entity/component field (JPA column, injected dep, component prop) | `id, qualifiedName (Owner.field), dataType (1.1 reuse), framework, meta.column` |
| `component` *(1.3)* | a UI component (React function/class, Angular @Component) | `id, qualifiedName, framework, stereotype, file, span` |

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
| `exposes` *(1.3)* | handler symbol → route (the endpoint a controller method serves) | static | EXTRACTED |
| `injects` *(1.3)* | consumer class → dependency type (the DI graph; CLASS-LEVEL, outgoing from class) | static | EXTRACTED |
| `renders` *(1.3)* | component → child component (the UI render tree) | static | EXTRACTED |
| `produces` *(1.3)* | producer method → produced type (@Bean/@Factory → return type; outgoing from method) | static | EXTRACTED |

> 1.3 reuses the existing `references` rel for JPA entity associations (field → related type, outgoing
> from the field); see the framework-semantics meta subsection below for its edge `meta`.

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

### 2.1 Framework-semantics edge & field meta *(1.3)*

The 1.3 framework-semantics layer (Spring track built in `packages/parsers/src/java/spring.ts`;
Node/NestJS/Express, React, Angular planned, reusing the same kinds/rels — no schema change) stamps
extra `meta` on a few edges/nodes. All framework edges carry `method:'static'`, `provenance:'EXTRACTED'`,
`confidence:1`, `evidence.by:'lang:java/spring'`.

**JPA `references` edge meta** (field → related type, on an `@Entity`; cardinality is the relation
annotation NAME — the multiplicity — since the args only carry the other attributes):
```json
{ "cardinality": "ManyToOne", "fetch": "FetchType.LAZY", "cascade": "{CascadeType.PERSIST}",
  "mappedBy": "payments", "orphanRemoval": "true" }
```
`cardinality` ∈ `ManyToOne | OneToMany | ManyToMany | OneToOne` (the annotation name). `cascade`/`fetch`
are captured verbatim from the annotation args (whitespace preserved); `mappedBy`/`orphanRemoval`
present only when written. A collection-valued association (`@OneToMany List<Payment>`) targets the
generic element type (`Payment`), not the collection head.

**`field` node — `meta.column`** (entity column metadata from `@Id`/`@Column`/`@GeneratedValue`/
`@JoinColumn`; absent for a non-annotated entity field):
```json
{ "id": true, "name": "applicant_id", "nullable": "false", "unique": "true",
  "length": "64", "joinColumn": "applicant_id", "generated": "IDENTITY" }
```
Keys: `id` (boolean, `@Id`), `name`/`nullable`/`unique`/`length` (from `@Column`), `joinColumn` (FK
column name from `@JoinColumn`, or `true` if nameless), `generated` (strategy from `@GeneratedValue`,
or `true`). The field's declared scalar type rides on the reused 1.1 `dataType` field.

**`route` node meta** — the route-param contract and access control, derived once per handler and
shared across its verbs/paths:
```json
{ "params": [ { "name": "id", "type": "Long", "in": "path" },
               { "name": "dto", "type": "LoanDTO", "in": "body" } ],
  "security": { "PreAuthorize": "hasRole('ADMIN')" } }
```
`params[].in` ∈ `path | query | body | header | cookie | part | form | matrix` (from
`@PathVariable`/`@RequestParam`/`@RequestBody`/`@RequestHeader`/`@CookieValue`/`@RequestPart`/
`@ModelAttribute`/`@MatrixVariable`). `security` is an annotation-name → expression map
(`PreAuthorize`/`PostAuthorize`/`Secured`/`RolesAllowed`); present on both the route node and the
handler method symbol node.

> 1.3 also stamps `meta.injects` (string[] of unresolved cross-file DI type names) on consumer class
> nodes and `meta.produces` (string[] of produced type names) on `@Bean` method nodes, for the
> cross-file resolver. The `member-of` rel aggregates a class's methods/fields (incoming to the class).

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
| table *(deep-extraction)* | `table:<schema.NAME>` |
| column *(deep-extraction)* | `col:<schema.TABLE.COL>` (kind `column`, prefix `col:` — intentional mismatch) |
| statement *(deep-extraction)* | `stmt:<file>@L<line>` |
| condition *(deep-extraction)* | `cond:<file>@L<line>` |
| exception-handler *(1.2)* | `exc:<file>@L<line>` |
| raise *(1.2)* | `raise:<file>@L<line>` |
| cursor *(1.2)* | `cursor:<file>#<name>@L<line>` |
| assignment *(1.2)* | `assign:<file>@L<line>` |
| case-branch *(1.2)* | `case:<file>@L<line>` |
| field *(1.3)* | `field:<path>#<qualifiedName>@L<startLine>` |
| route *(1.3)* | `route:<httpMethod> <routePath>@<file>#L<line>` |
| component *(1.3)* | `comp:<path>#<qualifiedName>@L<startLine>` |
| edge | `e:<blake3(src|dst|rel)>` |

IDs must be reproducible across runs given unchanged source → stable git diffs and durable external references.

## 5. Invariants (enforced by `core`, tested in M0)
1. Every edge `src`/`dst` resolves to an existing node (no dangling refs after a build).
2. `id` is unique per node; `(src,dst,rel)` collapses per the conflict rule.
3. `hash` changes iff node content changes (drives incremental updates).
4. `kind`/`rel`/`method`/`provenance` are closed enums (unknown → validation error).
5. Unknown `meta` keys are preserved on read→write (forward-compat).

## 6. Versioning
`schemaVersion` in the manifest. Additive fields are backward-compatible; **there is no `crib migrate`
command.** Schema evolution is automatic + additive — every 1.0→1.3 field is OPTIONAL +
`additionalProperties:true`, so an old soul loads verbatim; re-indexing stamps the new fields onto the
SAME node (id-stable, hash-stable, in-place); persisted dossiers rebuild on demand via the
`shapeVersion` + `schemaVersion` staleness gate in `readDossier`. No rewrite, no data loss. JSON Schema
is vendored under `.crib/schema/` so the soul is self-describing.
