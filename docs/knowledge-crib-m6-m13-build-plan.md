# Knowledge-crib — Unified Build Plan M6 → M13

> Synthesis of seven parallel design judges + one adversarial principal review into a single ordered
> cross-milestone plan. Scope: **M6** (incremental update + git hook + `.crib` merge driver),
> **M7** (clustering + deterministic embeddings + web UI), **M8** (tree-sitter plugin languages),
> **M10** (PL/SQL + SQL data-flow), **M11** (CFG + guard chain), **M12** (rule extraction / export),
> **M13** (offline multimodal worker).

This plan supersedes the per-milestone sketch in `knowledge-crib-build-plan.md` for the milestones it
covers; the build-plan table remains the authoritative scope/test-gate index.

---

## 0. Verified facts & judge-conflict reconciliations

The judges disagreed on three load-bearing facts. All verified against source on 2026-06-24.

| Claim | Verdict | Source |
|---|---|---|
| "M7/M10–M12 need no schema bump — `guard`/`cfgPath`/`branch`/`inLoop`/`inException` pre-declared on Edge" | **PARTLY FALSE.** `guard`, `branch` exist; `cfgPath` is `string` (scalar, not `string[]`); `inLoop`, `inException` are **absent**. | `packages/soul-schema/src/types.ts:89-99` |
| "`runResolve` hardcodes `resolveTypeScript`" | **TRUE.** No registry; single call at line 19. | `packages/pipeline/src/resolve/index.ts:17-22` |
| "manifest `stats.incrementalSince` + `repo.vcsHead` declared in soul-format §4" | **TRUE** (both optional). `newManifest` does NOT populate them. | `types.ts:101-129`, `manifest.ts:28-48` |
| "`SqliteIndexStore.applyDelta` is a stub" | **FALSE — fully implemented.** DELETE-by-id across `nodes`/`nodes_fts`/`edges` then re-insert. | `sqlite-index.ts:55-66` |

**Consequences:**

- **M6** needs **no** manifest bump; it stamps `repo.vcsHead` + `stats.incrementalSince` (both already
  optional) best-effort in `indexRepo` and `updateRepo`.
- **M11** needs an **additive** Edge type bump: `cfgPath?: string → string[]`, add `inLoop?: boolean`
  and `inException?: boolean`. **Evidence (P0-3):** grep confirms the only reference to `cfgPath` in
  `packages/` (excluding `dist`/tests) is its declaration at `types.ts:93` — **no producer emits it
  and no consumer reads it**, so the change is backward-compatible on read. Bump `SCHEMA_VERSION`
  `1.0 → 1.1` **and** add a loader version gate so a v1.1 `cfgPath: [...]` never lands in a
  v1.0-labeled soul. A round-trip test reads a v1.0-written soul (scalar/absent `cfgPath`) and asserts
  it loads as `undefined`, and that a lone scalar is not silently widened to `[scalar]`.
- **The resolver dispatch table** (`ResolverRegistry`) is a hard prerequisite for M8, M10, and M11.
  It lands first as a no-op refactor (P0a). `runLink`'s signature change (`docFiles?` param) is touched
  by M6/M7/M13 — land it **once** in P0/M6 rather than three times.

---

## 1. Sequencing strategy

### Critical path
**P0 (dispatch refactor) → M10 → M11 → M12** is the long dependent spine (SQL → CFG → rule
extraction). M8 is a **leaf** — nothing in M6–M13 depends on it — so it slots anywhere after P0.
M6, M7, M13 are independent of dispatch but share hot files (`pipeline.ts`, `cli.ts`,
`linker/index.ts`, `soul-store.ts`).

### Dependency DAG
```
P0 (resolver dispatch) ──┬─► M10 (PL/SQL + SQL resolver) ─► M11 (CFG) ─► M12 (rules)
                          ├─► M8  (tree-sitter + Python)   [leaf, independent of M10]
                          └─► M7  (needs no dispatch; shares pipeline.ts)

M6  (incremental)   [depends on nothing; shares pipeline.ts/cli.ts with M7]
M13 (multimodal)    [depends on nothing; shares cli.ts/linker/index.ts]
```
**M10 is NOT dependent on M8** (hand-rolled PL/SQL vs the `GrammarPool`) — the critical path proceeds
without waiting on wasm infra.

### Shared-file chokepoints

| Shared file | Touchers | Mitigation |
|---|---|---|
| `packages/pipeline/src/pipeline.ts` | M6, M7, M8, M10, M11 | Serialize the wiring edits; isolate package work in parallel. |
| `packages/cli/src/cli.ts` | M6, M7, M8, M13 | Distinct `case` branches; merge serially. |
| `packages/pipeline/src/resolve/index.ts` | P0, M8, M10, M11 | P0 creates the registry; others **register** (append-only). |
| `packages/pipeline/src/linker/index.ts` | M6, M7, M13 | Land the `docFiles?` signature once in P0/M6. |
| `packages/soul-schema/src/types.ts` | M11 only | One additive bump. |
| `packages/core/src/soul-store.ts` | M6 (`setVcsHead`), M11 (`annotateEdges`), M13 (`setCapabilities`) | Three distinct additive methods. |

### Waves
- **WAVE 0 — Prerequisites:** P0a dispatch refactor. P0b Edge additive bump may land here or in M11.
- **WAVE 1 — Substrate:** M6 (incremental + merge driver). M7/M13 isolated builds may start.
- **WAVE 2 — Spine:** M10 → M11 → M12 (serial). M8 in parallel (append-only resolver registration).
- **WAVE 3 — Integration:** fold M7/M13 wiring into the shared files; serialize against M6's hunks.

---

## 2. P0 — Prerequisite (land first)

### P0a — Resolver dispatch table
- **NEW** `packages/pipeline/src/resolve/resolver-registry.ts` — `Resolver { name; supports(file): boolean;
  resolve(table, root, files): ResolveResult }`; `ResolverRegistry` with `register/resolve/all`.
- **EDIT** `resolve/index.ts` — `runResolve(soul, root, files, resolvers?)`; build `SymbolTable` once;
  partition files per resolver; merge. Default `[TypeScriptResolver]`. Existing TS tests pass unchanged.
- **EDIT** `ts-resolver.ts` — refactor to the `Resolver` shape; no behavioral change.
- **EDIT** `pipeline.ts` — thread `resolvers?: Resolver[]` through `IndexOpts`.

### P0b — Edge additive bump (may slide into M11)
- **EDIT** `types.ts`: `cfgPath?: string → string[]`; add `inLoop?`, `inException?`. Bump `SCHEMA_VERSION 1.0→1.1`.
- **EDIT** loader: reject/normalize version mismatch on read.

---

## 3. Per-milestone plans

### M6 — Incremental update (git-anchored scoped re-extract) + merge driver

**Headline gate (rewritten honestly, per P0-1):** *edit the body of one `.ts` file (an edit that does
NOT change its exported API) → after `updateRepo` + `applyDelta`, `git diff --stat .crib` shows only
that file's shard chunk(s) + `crib.json`.* Reverse-dependency files rewrite their chunks with
byte-identical content (atomic write of identical bytes → no git diff). An edit that DOES change the
API legitimately alters reverse-deps' edge shards — that is correct, not a gate violation.

**Incremental algorithm (P0-1/P0-4 fix — reverse-dependency closure):**
```
1. head = currentHead(root)               (throw → caller degrades to full indexRepo)
2. since = opts.since ?? manifest.stats.incrementalSince ?? manifest.repo.vcsHead
3. if !since → return null                 (caller does full indexRepo)
4. changedPaths = changedFilesSince(root, since)
5. scopeFiles = changedPaths ∪ reverseClosure(soul, changedPaths)
      reverseClosure = { pathFromId(edge.src) : pathFromId(edge.dst) ∈ changedPaths }
      (captured BEFORE removal; single pass over edges; covers imports/calls/inherits/
       describes/references — any edge whose dst resolves into a changed file)
6. before = fileScopedIds(soul, scopeFiles)         (nodes by file∈scope; edges by src OR dst ∈ scope)
7. for p of changedPaths: soul.removeByFile(p)       (only changed files; reverse deps keep their nodes)
8. changedMetas = metaForPaths(root, changedPaths); runStructure(soul, root, changedMetas)
9. parse = runParse(soul, registry, root, changedMetas)
10. scopeMetas = metaForPaths(root, scopeFiles); resolve = runResolve(soul, root, scopeMetas)
11. link = runLink(soul, root, threshold, scopeFiles-as-docFiles)
12. soul.setVcsHead(head); soul.commit(now)
13. delta = buildDelta(soul, before, scopeFiles)     (changed.nodes/edges = current scope records;
                                                       removed = before ∖ after; membership by src AND dst)
return { delta, changedPaths, scopeFiles, parse, resolve, link }
```
Why this is correct: `removeByFile(A)` deletes incoming `B→A` (dst ∈ A) but leaves B's symbol nodes.
Re-resolving the **closure** re-emits `B→A` because `B ∈ scopeFiles` and B's symbols are still in the
SymbolTable. Unchanged B re-emits identical edges → identical shard bytes → no git diff. Incoming edges
are recovered (no silent loss) and the shard-diff gate holds for body-only edits. `fileScopedIds` and
`buildDelta` scope edges by `pathFromId(src)` **and** `pathFromId(dst)` (edges cannot route by own id —
`pathFromId('e:…')` is `undefined`).

**Files:**
- **NEW** `packages/pipeline/src/vcs.ts` — `isGitRepo`, `currentHead`, `changedFilesSince` (child_process
  `git`; POSIX repo-relative paths; typed throw on non-git/missing sha).
- **NEW** `packages/core/src/delta.ts` — `fileScopedIds`, `buildDelta` (returns `IndexDelta`). Export in `core/src/index.ts`.
- **NEW** `packages/pipeline/src/update.ts` — `updateRepo` (above; returns `null` to signal full degrade).
- **EDIT** `structure.ts` — `metaForPaths(root, paths): FileMeta[]` (stat + `langForPath`; no full walk).
- **EDIT** `linker/index.ts` — `runLink(soul, root, threshold?, docFiles?: string[])`: if `docFiles`
  given, restrict the doc-section emit loop to those files (InvertedIndex still over the whole soul).
- **EDIT** `pipeline.ts` — after `soul.commit` in `indexRepo`, best-effort stamp `vcsHead`=`currentHead`
  (try/catch non-git); leave `incrementalSince` set by update path.
- **EDIT** `soul-store.ts` — `setVcsHead(sha)` (sets `repo.vcsHead` + `stats.incrementalSince`).
- **EDIT** `cli/runtime.ts` — `openIndexOnly(rt)` (open the IndexStore at the manifest path WITHOUT `buildFromSoul`).
- **EDIT** `cli.ts` — `crib update [--since <sha>]` (openSoul → `updateRepo`; null → full `indexRepo`
  + `buildIndex`; else `openIndexOnly` → `applyDelta` → close; print `changedPaths` + counts);
  `crib reindex` (alias to full index).
- **EDIT** `verbs.ts` — `detectChanges({since?})` real dry-run: `since = args.since ?? incrementalSince`;
  `changedFilesSince`; report `changedSymbols` (nodes whose `file ∈ changedPaths`) + projected
  `removedEdges` (edges touching `changedPaths`). **Must not mutate soul or commit** (P1-5:
  hash-before/after assertion test).

**Merge driver (`.crib` chunk 3-way merge):**
- **NEW** `packages/core/src/merge.ts` — `parseChunk(text)→Map<id,record>`; `mergeThreeWay(base, ours, theirs,
  kind)` (edges → per-id `resolveEdgeConflict`; same-id differing nodes → take ours + stderr note;
  one-sided changes kept); `serializeChunk(map)→string` (sorted by id, matching the store's order).
- **NEW** `packages/cli/src/hooks.ts` — `installHooks(root)`: write a **managed block** into
  `.git/hooks/post-commit` (`# >>> kcrib managed >>>` … `# <<< kcrib managed <<<`) invoking `crib update`;
  append `.crib/** merge=kcrib` to `.gitattributes`; `git config merge.kcrib.driver '<bin> merge-driver %O %A %B %P'`.
  Idempotent (re-run updates the managed block; never clobbers user content outside it).
- **EDIT** `cli.ts` — `crib install-hooks`; `crib merge-driver %O %A %B %P` (detect node vs edge chunk
  by `%P`; run `mergeThreeWay`; write merged result to `%A`; exit 0 on success, 1 on unresolvable node conflict).

**Tests:**
- **NEW** `update.test.ts` (THE M6 gate): git-init fixture → `crib index` (commit; `vcsHead` set) →
  snapshot `.crib/nodes` + `.crib/edges` file list + per-file hashes → edit the BODY of one `.ts` file
  (no API change) → `updateRepo` + `applyDelta` → assert (a) only that file's shard chunk(s) + `crib.json`
  diff; reverse-dep chunks rewrite byte-identical (no diff); (b) post-update `query`/`impact`/`shortestPath`
  over the changed symbol correct; (c) `vcsHead` + `incrementalSince` advanced. PLUS an API-change edit
  case asserting reverse-deps' edge shards legitimately change. PLUS non-git degradation (full indexRepo,
  `vcsHead` unset, no throw). PLUS `detectChanges` immutability (hash-before/after identical; no commit).
  PLUS `applyDelta` FTS idempotency (no-op update → `query()` results unchanged, no duplicate FTS rows).
- **NEW** `delta.test.ts` — added node → `nodes[]`; deleted → `removed[]`; unchanged-file node absent;
  edge A→B (B changed) present; edge between two unchanged absent; membership by src AND dst both directions.
- **NEW** `merge.test.ts` — synthetic edge conflict (same `(src,dst,rel)`, EXTRACTED vs INFERRED, lower vs
  higher confidence) resolves via the rule; one-sided node additions kept; serialize round-trips stably.
- **NEW** `hooks.test.ts` — `installHooks` is idempotent (managed block not duplicated); `.gitattributes`
  gains the entry; `git config` reads the driver; merge-driver exits 0 on a clean 3-way and resolves the
  synthetic conflict.

---

### M7 — Clustering + deterministic embeddings + web UI
Pure-JS Louvain over structural adjacency; `member-of` edges EXTRACTED conf 1.0; cluster label INFERRED
via `Enricher` with graceful slug fallback. Signal-4 = offline TF-IDF 256-d hashed L2-normalized
embeddings + pure-JS ANN, fires ONLY when signals 1–3 are empty for a pair, caps conf ≤0.5, provenance
INFERRED, method `semantic`, references-only (rank 4 — barred from `describes`, can't beat EXTRACTED).
UI = vendored `cytoscape.js` compound nodes from a `graph.json` snapshot.

**Files:** NEW `cluster/{louvain,slug,index}.ts`, `linker/{embeddings,vector-index,signals/semantic}.ts`;
EDIT `linker/score.ts` provenance edit BELONGS IN `linker/index.ts` edge construction (NOT score.ts — P1-1);
EDIT `linker/index.ts` merge semantic; EDIT `pipeline.ts` wire `runCluster` after `runLink` before commit;
EDIT `mcp/enrichment.ts`; NEW `packages/ui/{index.html,main.ts,reader.ts}` + vendored cytoscape; EDIT
`cli.ts` (`crib viz`); EDIT `NOTICE`.

**Gate:** clusters render (compound DOM nodes); determinism (byte-identical cluster ids + member-of across
runs); deterministic precision ≥0.9 on docs-linked **unchanged**; semantic recall strictly > deterministic-only;
graceful-degrade offline; 100k-LOC perf guardrail.

---

### M8 — Tree-sitter WASM plugin languages (Python first)
`web-tree-sitter` + vendored `.wasm` grammars from `tree-sitter-wasms` (no `curl|sh`; source is the npm
dep). `GrammarPool` caches `{Language,Parser}` per grammar per run. Ship Python first (path/package imports
+ real `inherits` via class bases + honest `types:'none'`). Soft per-file timeout (measure + degrade);
hard worker preemption deferred (P1-3: cache only the `Language`, fresh `Parser` per parse, OR
`parser.reset()` after each parse — test no stale-tree contamination between a timed-out file and the next).
`ResolverRegistry` (P0) registration — no new dispatch mechanism.

**Files:** EDIT `parsers/{package.json,src/types.ts,src/index.ts}`; NEW `grammar-pool.ts`, `grammars/python.wasm`
(+ LICENSE + README), `python/PythonExtractor.ts` (+ test), `fixtures/python/`; EDIT
`pipeline/extract-ctx.ts`, `parse.ts`; NEW `resolve/python-resolver.ts`; EDIT `resolve/index.ts` (register);
EDIT `pipeline.ts` (`IndexOpts.resolvers?/grammarPool?/workerTimeout?`); EDIT `cli/runtime.ts`;
EDIT `NOTICE`; optional `scripts/fetch-grammar.ts`.

**Gate:** golden (fixture → exact nodes/edges); degradation (missing grammar → file node only, no throw;
malformed → empty); id-stability; capability-honesty (≥1 imports/calls/inherits, ZERO type edges); TS+Python
dispatch in one `indexRepo` without cross-talk; 71 existing green.

---

### M10 — PL/SQL extractor + SQL data-flow (Phase 3c)
Hand-rolled tokenizer + recursive-descent parser for the migration-relevant subset (DDL + DML + control
flow + call sites), offline, zero-dep. Intra-file edges (`member-of` col→table, `executes` proc→statement,
same-file `reads`/`writes`) emitted by the extractor; cross-file (proc→proc calls, statement→table/col
reads/writes across files) emitted by a new `resolveSql` against a `SchemaCatalog` (built from
`soul.iterate('table')`/`'column'`). DDL discovered in `.sql` AND inline in `.pkb/.pks`.

**Files:** NEW `parsers/src/plsql/{lexer,ast,parser,PlSqlExtractor}.ts` (+ test), fixture `__fixtures__/claims.pkb`;
EDIT `parsers/src/index.ts`; NEW `resolve/schema-catalog.ts`, `resolve/sql-resolver.ts`; EDIT `resolve/index.ts`
(register via P0); EDIT `pipeline.ts` (register `PlSqlExtractor` default). **P1-4:** the AST contract M11
consumes (block spans, branch/loop markers, exception-handler ranges, call-site positions) is specified HERE,
in `ast.ts` doc-comments, before M11 is sequenced behind it.

**Gate:** golden package (nodes/edges incl `executes`/`reads`/`writes`/`guarded-by`); cross-file resolver
against the catalog; 71 existing green; mixed TS+SQL `indexRepo`.

---

### M11 — CFG pass + guard chain + condition nodes
Generic basic-block CFG + path-condition framework under `packages/pipeline/src/cfg/`. Annotate-existing
(preferred over emit-new) — `calls`/`executes` edges gain `guard`/`cfgPath:string[]`/`branch`/`inLoop`/
`inException` via a new `soul.annotateEdges(updates)` (overwrite primitive; merges via the conflict rule
where provenance differs). Per-language dispatch (P0) → `plsql-cfg.ts`. Condition nodes (`cond:`) emitted.
**P0b Edge bump lands here if not in P0:** `cfgPath string→string[]`, add `inLoop`/`inException`,
`SCHEMA_VERSION 1.0→1.1` + loader gate + round-trip normalization test.

**Files:** EDIT `types.ts` (additive + version); EDIT `manifest/loader` (gate); NEW
`cfg/{basic-block,guard-chain}.ts`, `resolve/plsql-cfg.ts`, `resolve/dispatch.ts`; EDIT `resolve/index.ts`
(CFG step sequencing); EDIT `soul-store.ts` (`annotateEdges`); NEW fixture + `cfg.test.ts`.

**Gate:** guard-chain correctness (hand-derived path conditions match); CFG edges carry `cfgPath:string[]`;
condition nodes emitted; round-trip reads a v1.0 soul with no `cfgPath` (loads as `undefined`, no widening);
71 existing green.

---

### M12 — `extract_rules` verb + `export --format rules|mermaid`
Consumes the M11 guard-annotated CFG. New MCP verb `extract_rules({procedure, opts})` walks a procedure's
CFG, materializes the inherited `cfgPath`, emits the decision-table / rule records. CLI `crib export
--format rules|mermaid|graph.json|report` renders.

**Files:** EDIT `mcp/verbs.ts` (`extract_rules`); EDIT `cli.ts` (`crib export`); NEW `pipeline/src/rules/`
(decision-table assembly + mermaid renderer); NEW `rules.test.ts`.

**Gate:** decision-table matches hand-derived rules from a golden PL/SQL package; `export --format mermaid`
produces valid graph markup; 71+ existing green.

---

### M13 — Offline multimodal worker (PDF/image/whisper audio)
Sibling `python/` dir (standalone `pyproject`, `uv`-managed, OUTSIDE the pnpm `packages/*` glob) holding
`crib_worker`, invoked as a SUBPROCESS by the TS CLI. Default `crib index`/`crib serve` stay pure-TS and
untouched. Worker emits soul-schema-conformant `media-seg` nodes (`id=media:<path>#<tStartMs>`, already
supported by `idFor`) + `member-of` edges to the existing `file:<path>` node (Phase 1's `discoverFiles`
walks all non-ignored files, so the worker does NOT emit file nodes). Segment transcript text in
`node.meta.text` with `meta.tStart/tEnd/modality/lang`. Sequence PDF (pypdf, zero-model) → audio
(faster-whisper) → image (surya). Cross-modal linking reuses the deterministic
`explicitSignal`/`identifierSignal`/`pathSignal` by feeding each `media-seg.meta.text` as an
MdSection-like `{prose, codeRefs:[], links:[]}` — provenance stays EXTRACTED.

**Files:** NEW `python/{pyproject.toml,crib_worker/{cli,emit,pdf,audio,image}.py,README.md,tests/}`; NEW
`pipeline/src/multimodal/{ingest,index}.ts`, `linker/media.ts`; EDIT `cli.ts` (`crib multimodal <paths>`,
DO NOT touch `cmdIndex`); EDIT `soul-store.ts` (`setCapabilities`); EDIT `.gitignore`; EDIT
`extractor-plugins.md` + `cli.md` + `build-plan.md` (the `later` row); minor EDIT `linker/index.ts`
(export signal helpers).

**Gate:** worker golden (fixed PDF+WAV → `media-seg` ids match grammar, byte-stable hashes, `member-of`);
contract round-trip (`ingestStaging` → `commit` → reload, `capabilities.multimodal===true`); linker
(transcript mentioning `AuthService.login` → `describes` edge EXTRACTED conf≥0.8); determinism (greedy
decoding → byte-identical); degradation (corrupt media → no media-seg, no throw); offline
(`--model-path`, network disabled); pure-TS safety (default index/serve unchanged, worker absent → graceful).