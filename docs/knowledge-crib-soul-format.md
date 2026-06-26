# Knowledge-crib — The Soul Format (v1.0 / 1.1 / 1.2 / 1.3 spec)

> The **soul** is the project's portable memory: chunked, git-committable files that are the
> **source of truth** [Q9]. The fast index (LadybugDB/swappable) is derived from it and
> rebuildable. Any agentic IDE — and SeeroFlow [Q38] — can read the soul **cold, without the
> engine**. This spec is the contract everything else hangs off.

---

## 1. Design goals → choices
| Goal | Choice |
|------|--------|
| Cross-IDE, agent-agnostic | Plain files + published JSON Schema + format version. Engine optional. |
| Git-committable, small diffs | **JSONL** (one record/line) + **sharded chunks** keyed by source path → a one-file edit touches one chunk. |
| Incremental upgrade as project evolves | Per-node content hash (blake3); rewrite only affected chunks; manifest tracks `incrementalSince`. |
| Source of truth, index derived | Soul holds structure; index is a cache built from soul. Single-writer, one direction. |
| Lean (no repo duplication) | Code/doc nodes store **references** (`file` + `span` + `hash`), **not copied text**. Rehydrate from source on demand. |
| Portable + scalable | Chunked soul scales past Graphify's single 512 MiB `graph.json`; `crib export` still emits one flat `graph.json` for compat. |

---

## 2. On-disk layout
```
.crib/                         # COMMITTED to git (the soul travels with the repo)
  crib.json                    # manifest (versions, repo id, chunking, stats, capabilities)
  nodes/<shard>/<chunk>.jsonl  # node records, sharded by source-path hash
  edges/<shard>/<chunk>.jsonl  # edge records
  clusters/clusters.jsonl      # community detection output
  dossiers/<shard>/<hash>.json # persisted deep-context artifacts (Workstream E; sharded by node-id hash)
  schema/                      # vendored JSON Schema for nodes/edges/manifest (self-describing)
  .gitignore                   # ignores index/ and embeddings/ by default
  index/                       # GITIGNORED — derived LadybugDB/sqlite + ANN; rebuildable
    ladybug.db
  embeddings/<shard>/*.f16     # GITIGNORED — vectors (large, regenerable)
```
**Why `.crib/` is committed** (unlike `.git`): it *is* the memory. Derived/heavy bits (`index/`,
`embeddings/`) are gitignored and rebuilt locally.

**Sharding:** `shard = first 2 hex of blake3(sourcePath)`; within a shard, roll a new chunk file at
`maxChunkLines` (default 5000). One file's records cluster into one shard → minimal merge conflicts.

---

## 3. Record schemas (JSON Schema, abridged)

### Node
```jsonc
{
  "id": "sym:src/auth/AuthService.ts#AuthService.login@L42",  // stable, deterministic, human-readable
  "kind": "symbol",            // symbol|file|doc-section|media-seg|explanation|cluster (1.0)
                              // +table|column|statement|condition (1.1, deep-extraction)
                              // +raise|exception-handler|assignment|case-branch|cursor (1.2, behavior)
                              // +route|field|component (1.3, framework-semantics)
  "type": "method",            // AST type (class|function|method|interface|…) or doc level (h2…)
  "name": "login",
  "qualifiedName": "AuthService.login",
  "file": "src/auth/AuthService.ts",
  "span": { "start": 42, "end": 58 },   // line range — text is referenced, NOT copied
  "lang": "typescript",
  "signature": "login(email: string, pw: string): Promise<Session>",
  "clusterId": "c:auth",
  "hash": "blake3:9f2c…",      // content hash → change detection + dedup
  // deep-extraction (1.1): schema/table/dataType/sqlKind/expr/branch + meta.columns/attributes/collection
  // behavior (1.2): errorCode/errorMessage (raise) · whenSelector (exception-handler|case-branch)
  //                 assignTarget (assignment) · cursorQuery (cursor) · commentRef (explanation)
  // framework-semantics (1.3): httpMethod/routePath (route) · framework/stereotype (symbol/component)
  //                            · dataType (field, reused from 1.1) · meta.injects (bean DI list)
  "meta": {}                   // extensible; unknown keys preserved on round-trip
}
```
**ID grammar (stable across runs — critical for git diffs + cross-tool refs + SeeroFlow):**
- symbol → `sym:<file>#<qualifiedName>@L<startLine>`
- file   → `file:<path>`
- doc    → `doc:<file>#<anchor>`
- media  → `media:<file>#<tStart>` · cluster → `c:<slug>`
- 1.1/1.2 behavior nodes → `raise|exc|assign|case:<file>@L<line>`, `cursor:<file>#<name>@L<line>`,
  `stmt:<file>@L<line>`, `cond:<file>@L<line>`, `expl:<path>@L<startLine>` (deterministic via `idFor`)
- 1.3 framework-semantics → `route:<HTTP> <routePath>@<file>#L<line>` (route),
  `field:<path>#<qualifiedName>@L<startLine>` (field), `comp:<path>#<qualifiedName>@L<startLine>` (component)

### Edge
```jsonc
{
  "id": "e:blake3(src|dst|rel)",
  "src": "sym:src/auth/AuthService.ts#AuthService.login@L42",
  "dst": "sym:src/auth/TokenService.ts#TokenService.issue@L88",
  "rel": "calls",              // calls|imports|inherits|implements|describes|references|derived-from (1.0)
                              // +executes|reads|writes|guarded-by (1.1, deep-extraction)
                              // +raises|handles|iterates|declares (1.2, behavior)
                              // +exposes|injects|renders|produces (1.3, framework-semantics)
  "method": "static",          // static|explicit|identifier|path|semantic|inferred (HOW it was derived)
  "provenance": "EXTRACTED",   // EXTRACTED (deterministic) | INFERRED (LLM/heuristic)   [Q35]
  "confidence": 1.0,           // 0..1
  // guard-chain (1.1): cfgPath:string[] (AND-chain entry→callsite), branch, inLoop, inException
  "evidence": { "snippet": "return tokenService.issue(...)", "by": "ts-call-resolver" },
  "meta": {}
}
```

### Conflict / merge rule (deterministic — embed in spec, not code-only)
When two edges share `(src,dst,rel)`:
1. **EXTRACTED/static wins** over INFERRED.
2. Among same provenance → higher `confidence` wins.
3. Loser kept only if `confidence ≥ link-threshold` (default 0.4), else dropped.
This rule is what the `.crib` git **merge driver** applies on chunk conflicts (union + rule).

---

## 4. Manifest — `crib.json`
```jsonc
{
  "cribFormatVersion": "1.0",
  "schemaVersion": "1.3",       // 1.0 | 1.1 | 1.2 | 1.3 — all forward-compatible (unknown fields preserved)
  "repo": { "id": "<uuid>", "root": ".", "vcsHead": "<git sha at last full index>" },
  "generator": { "tool": "knowledge-crib", "version": "x.y.z" },
  "chunking": { "shardHexDigits": 2, "maxChunkLines": 5000, "format": "jsonl" },
  "stores": { "soul": "jsonl-chunked", "index": ".crib/index/ladybug.db (derived, gitignored)" },
  "stats": { "nodes": 0, "edges": 0, "clusters": 0, "lastUpdated": "ISO-8601",
             "incrementalSince": "<git sha>" },
  "capabilities": { "embeddings": false, "multimodal": false }   // grows as features land
}
```

---

## 5. Incremental update protocol (the "upgrades as project evolves" part)
1. Detect changed files (git diff / watcher) since `stats.incrementalSince`.
2. For each changed file: re-extract → new node/edge records.
3. Compare by `hash`; rewrite **only the affected shard chunks**.
4. Prune edges referencing deleted nodes (dangling-ref sweep, scoped to touched shards).
5. Update manifest `stats` + `vcsHead` + `incrementalSince`.
6. Rebuild only the touched slice of the derived index.
Cost ∝ change size, not repo size.

---

## 6. Versioning & migration
- `cribFormatVersion` (file layout) + `schemaVersion` (record shape) in the manifest.
- Supported schema versions: `1.0`, `1.1`, `1.2`, `1.3`. The loader never widens an older soul — a 1.1
  soul reloads verbatim and re-commits byte-stably (1.1's `cfgPath:string[]` + `inLoop`/`inException`
  are preserved, not silently bumped to 1.2). New kinds/rels/fields are **additive**.
- 1.1 widened `Edge.cfgPath` `string → string[]` + added `inLoop`/`inException` (guard chain).
- 1.2 added behavior node kinds (`raise`/`exception-handler`/`assignment`/`case-branch`/`cursor`),
  behavior rels (`raises`/`handles`/`iterates`/`declares`), and node fields
  (`errorCode`/`errorMessage`/`whenSelector`/`assignTarget`/`cursorQuery`/`constraints`/`commentRef`).
- 1.3 added the **framework-semantics** layer — node kinds `route`/`field`/`component`,
  rels `exposes`/`injects`/`renders`, and node fields `httpMethod`/`routePath`/`framework`/
  `stereotype` (plus `dataType` reused on `field`, and `meta.injects` on bean symbols). These put an
  app-framework codebase "above SQL": the API surface, the DI graph, the entity model, and (planned)
  the UI render tree become queryable graph artifacts the way tables/SQL already were. See §9.
- **Schema evolution / migrate:** There is NO `crib migrate` command. Schema evolution is automatic
  and additive: (1) every 1.0→1.3 field is OPTIONAL + `additionalProperties:true`, so an old soul loads
  verbatim; (2) re-indexing stamps the new 1.3 fields onto the SAME node (id-stable, hash-stable,
  in-place); (3) persisted dossiers rebuild on demand via the `shapeVersion` + `schemaVersion`
  staleness gate in `readDossier` (`shapeVersion` undefined → stale → rebuilt). No rewrite, no data
  loss. The `crib migrate` test referenced in testing.md §7 IS the schema round-trip + forward-compat
  test in `packages/core/src/validate.test.ts` (1.0/1.2 nodes validate under the 1.3 schema; a 1.2 node
  → stamp 1.3 fields → re-validate, id unchanged). **Dist gate:** `pnpm test` runs
  `pretest: pnpm -r run build` first, so tests never run against stale dist (packages export from
  `./dist`, so a stale dist silently masks bugs); `pnpm verify` = build+test+lint.
- **Round-trip safety:** unknown fields are preserved, so a newer soul stays readable by an older
  reader (forward-compatible) for additive changes.

---

## 7. SeeroFlow read contract [Q38] (and any external consumer)
Two tiers — both stable, versioned:

**Tier 1 — engine-free (universal):** read `.crib/` directly.
- Discover `crib.json` → check `cribFormatVersion`.
- Stream `nodes/**.jsonl` + `edges/**.jsonl` (JSONL → line-by-line, no full load).
- Resolve by ID grammar (§3); look up clusters in `clusters/clusters.jsonl`.
- Validate against vendored `schema/`. A tiny reader lib ships as `@knowledge-crib/soul-reader`.

**Tier 2 — engine/MCP (rich):** call Knowledge-crib MCP verbs (`context`, `impact`, `query`) for
ranked/hybrid results. Needs the server running.

**Compat export:** `crib export --format graph.json` flattens chunks → one Graphify-style
`graph.json` for tools that expect it.

> SeeroFlow integration = a Tier-1 reader in a flow node (no engine dependency) for context load,
> with optional Tier-2 MCP calls when richer queries are needed. Contract is frozen at
> `schemaVersion` so flows don't break on engine upgrades.

---

## 8. Privacy / git hygiene
- Committed: structure (nodes/edges/clusters/manifest) — derived from code already in the repo, so
  no new secret exposure; text is referenced, not duplicated.
- Gitignored by default: `index/` (rebuildable) and `embeddings/` (large, regenerable).
- LLM-`INFERRED` edges are clearly tagged → a reviewer can filter to `EXTRACTED`-only for a
  trust-only view.

---

## 9. Framework-semantics layer (1.3) — the "above SQL" tier for app frameworks

1.1/1.2 made a **database** codebase queryable without reading it: tables, columns, the SQL a
procedure `executes`, the branches it guards. 1.3 does the same for an **app framework** codebase —
deriving the architectural artifacts a team actually reasons over, on top of the syntactic
symbol/CFG graph. The four artifacts below are all **pure + additive** (mutate symbol nodes, append
new nodes/edges); a non-framework class is a no-op. Every edge is `EXTRACTED`/`static`/`confidence 1`
— no guessing.

### New node kinds
| kind | what it is | key fields |
|------|-----------|------------|
| `route` | an HTTP endpoint | `httpMethod` (GET/POST/PUT/DELETE/PATCH/ANY), `routePath` (composed), `framework` |
| `field` | a class/entity/component field (JPA column, injected dep, component prop) | `dataType` (reused from 1.1), `qualifiedName` (`Owner.field`), `framework` |
| `component` | a UI component (React function/class, Angular `@Component`) | `framework`, `stereotype` |

A `field` is a **node** (not a bare symbol) so it can be the endpoint of `references`/`injects`/
`renders` and carry its own `dataType` — deliberate 1.3 design.

### New rels
| rel | src → dst | meaning |
|-----|-----------|---------|
| `exposes` | handler symbol → `route` | the endpoint a controller method serves (the API surface) |
| `injects` | consumer symbol → dependency symbol | the DI graph (consumer → injected bean type) |
| `renders` | component → child component | the UI render tree (React/Angular tracks) |
| `produces` | producer symbol → produced type | the @Bean/@Factory graph (a producer method → its return type) |

### Node + edge fields (1.3)
Beyond the identity fields (`httpMethod`/`routePath`/`framework`/`stereotype` on the node, `dataType`
reused on `field` from 1.1, `meta.injects` on bean symbols), 1.3 carries structured metadata on the
node's `meta` and on the `references` edge:

- **`route` params + security** — `meta.params` is `Array<{name, type?, in}>` where `in` ∈
  `path|query|body|header|cookie|part|form|matrix` (where a route param is bound); `meta.security` is
  `Record<string,string>` e.g. `{PreAuthorize: "hasRole('X')"}` (captured from `@PreAuthorize` on the
  handler). Surfaced on the route node and on the handler symbol.
- **`field.meta.column`** — `{id?, name?, nullable?, unique?, length?, joinColumn?, generated?}`
  (JPA `@Column` / `@JoinColumn` metadata); `field.dataType` (reused from 1.1) is the field's declared
  scalar type.
- **`meta.produces`** — `string[]` on a producer method: the produced type names (the cross-file
  counterpart of the `produces` edge, resolved by the Phase-3 Java resolver the same way
  `meta.injects` is).
- **`references` edge meta** — for a JPA relation field → related type: `{cardinality, fetch?, cascade?,
  mappedBy?, orphanRemoval?}`. `cardinality` is the relation annotation NAME
  (`ManyToOne`/`OneToMany`/`ManyToMany`/`OneToOne`) — the multiplicity; `cascade`/`fetch` are captured
  VERBATIM from the annotation args (whitespace preserved). Every framework edge is
  `method:'static'`, `provenance:'EXTRACTED'`, `confidence:1`, with `evidence:{snippet, by:'lang:java/spring'}`.

### Java / Spring Boot track (built + tested, schema 1.3)
The Spring pass (`packages/parsers/src/java/spring.ts`, Phase-2 Pass 4 of `JavaExtractor`) derives
four artifacts from a hand-rolled parse (tokenizer + structural parser; no tree-sitter):

1. **Stereotypes** — class-level annotations tag the symbol: `@RestController`/`@Controller`/
   `@ControllerAdvice` → `controller`, `@Service` → `service`, `@Repository` → `repository`,
   `@Component` → `component`, `@Configuration` → `config`, `@Entity`/`@Embeddable` → `entity`.
   Each carries `framework:'spring'` + `stereotype:'<role>'`, so the graph is filterable by
   architectural role.
2. **Routes** — every `@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`/
   `@RequestMapping` handler becomes a `route` node with the class-level base path (`@RequestMapping`
   on the class) composed onto the method sub-path. `@RequestMapping(method=RequestMethod.GET)` pins
   the verb; a pathless mapping maps to the base path (Spring does **not** derive a path from the
   method name). Paths are normalized: leading slash added, `//` collapsed, path variables (`/{id}`)
   preserved, and a totally-pathless controller yields `/`. The handler symbol → route via `exposes`.
3. **DI graph** — constructor-injected params (implicit autowire since Spring 4.3 — no `@Autowired`
   on the ctor) and `@Autowired`/`@Inject`/`@Resource` fields become `injects` edges
   (consumer → dependency type). **Intra-file** deps resolve in the extract pass; **cross-file** deps
   are recorded on the bean symbol's `meta.injects` (a `string[]` of dependency type names) and turned
   into `injects` edges by the Phase-3 Java resolver. Self-injection is skipped. DI is **gated on the
   bean stereotype** — a `@Autowired` field / ctor in a plain POJO emits nothing (it isn't Spring-managed).
4. **JPA relations** — `@ManyToOne`/`@OneToMany`/`@ManyToMany`/`@OneToOne` fields on an `@Entity`
   emit a `references` edge (field → related type), intra-file resolved. A **collection-valued**
   association (`@OneToMany List<Payment> payments`) targets the generic **element** type
   (`Payment`), not the collection head (`List`); single types (`@ManyToOne Applicant applicant`)
   use the field type directly. Gated on `@Entity` — a relation annotation on a non-entity field is
   not a persistence association and emits nothing.

**Resolver extension:** the Phase-3 `java-resolver` reads each bean's `meta.injects` and resolves
each dependency type cross-file (imports → same-package FQN), emitting `injects` edges with the same
`EXTRACTED`/`static`/`confidence 1` contract; intra-file deps already edged are skipped. The
resolver's capability set widens from `{imports, calls, inherits, implements}` to include `injects`.

**Coverage:** `packages/parsers/src/java/spring.test.ts` (15 tests — stereotypes, all five verbs +
method pinning, path normalization, path variables, non-controller no-op, constructor/field/self/
multi-param DI, bean gating, JPA all four relations + collection-element extraction + entity gating,
non-Spring no-op) and `packages/pipeline/src/resolve/java-resolver.test.ts` (cross-file DI:
`LoanController → LoanService → LoanRepository`, stereotypes survive, routes/exposes present).

### Planned tracks (not yet built)
- **Node/NestJS/Express** — `route` from `app.get`/`@Get`/`@Controller`, `injects` from
  constructor/Nest DI, stereotypes from decorators.
- **React** — `component` nodes, `renders` edges (the render tree), `field` for props/state.
- **Angular** — `component`/`directive`/`pipe` stereotypes, `renders`, `injects` via DI tokens.
These reuse the 1.3 kinds/rels above — no further schema change needed for them to land.

### Surfacing — the verbs that make a 1.3 graph replace reading the code
The 1.3 kinds/rels alone are storage; the **surfacing** tier is what makes a Java/Node/React/Angular
graph REPLACE reading the code. It is shared between the persisted dossier and the live MCP verbs
(`packages/core/src/dossier/framework.ts` is PURE over the soul, so the pipeline-persisted artifact
and the live `context` verb are byte-identical in shape):

- **`context` verb** — opt-in via `withFramework:boolean` (same convention as `withRules`/`withSource`;
  NOT unconditional). Returns `framework = {routes, produces, dependencies, dependents, relations,
  renders}`. A **class** scope (controller/`@Configuration`/`@Entity`/class-like type, or a symbol with
  incoming `member-of` children) aggregates across members via `member-of`; a callable/component/field
  uses METHOD scope (direct outgoing edges, dependencies lifted from the owning class for a callable).
  `lean:true` = the persisted-dossier subset (the `routes`+`produces` the callable OWNS); `lean:false` =
  the `context` verb's full set. **Supply chain (no round-trip):** a dependency whose type is a
  `@Bean`-produced type is surfaced with `kind:'produces'` + the producer brief in the SAME object
  (one-hop), built from one soul-wide `produces` scan. Unresolved `meta.injects`/`meta.produces` type
  names surface as `⚠ unresolved` entries (parity with the `gaps` verb).
- **`dossier` verb** — `buildDossier` attaches `framework` (the lean subset) + `shapeVersion:2`.
  `readDossier` reports `stale` when `shapeVersion != DOSSIER_SHAPE_VERSION` (so pre-2.0 persisted
  artifacts rebuild even though `schemaVersion` is unchanged at `1.3`). The serializer emits
  `## Routes` / `## Produces` / `## Dependencies` / `## Dependents` / `## Relations` / `## Renders`
  sections (each only when non-empty), grouped after `controlFlow` and before `## Docs`; Routes +
  Relations render as diff-friendly tables, the rest as bullets.
- **`gaps` verb** — new 1.3 anomaly arrays: `controllersWithoutRoutes` (a `controller`-stereotype class
  with member methods but zero `exposes` edges) and `unresolvedInjects` (a class with a `meta.injects`
  name but no emitted `injects` edge). Both added to the `summary` keys.
- **`viz`** — `buildVizGraph` surfaces `framework`/`stereotype`/`httpMethod`/`routePath` on node data;
  `makeSummary` is richer for `route` ("POST /api/loans"), `field` ("Field applicant → column
  applicant_id"), `component` ("react component LoanForm"), and `symbol` ("controller: LoanController").
  All framework edges are already emitted as viz edges.
