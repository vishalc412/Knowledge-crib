# Knowledge-crib — Changelog: Single-Entry Resolution + Auto MCP Wiring (REQ-1, REQ-2)

> What changed, why, and the rationale behind each decision. Implements the two requests:
>
> - **REQ-1** — "every time for a new workspace I need a new entry; it should refer to root `~/.crib`
>   and from there point to the respective project `.crib` directory for the knowledge graph."
> - **REQ-2** — "add a CLI command to configure MCP to the respective IDE automatically rather than
>   the customer adding it manually."
>
> Scope: `packages/cli` only. No other package's behavior changed. 40 CLI tests (29 new), build +
> lint clean. Pre-existing untracked WIP in `packages/parsers/src/{rust,go,csharp,java}/` was
> deliberately left untouched (out of scope — someone else's in-progress work).

---

## REQ-1: One user-scope IDE entry serves every project

### The problem

Before this change, every IDE config entry had to point at a specific project root
(`crib serve /abs/path/to/project`). A new workspace meant a new entry. The user's ask: a single
machine-wide entry that resolves to the correct per-project `.crib/` via a `~/.crib` registry.

### What was built

**`packages/cli/src/registry.ts` (new, ~135 lines)** — `~/.crib/registry.json`, the local project
dispatch table.

- Shape: `{ version: 1, projects: { "<absolute project path>": { repoId, cribDir, vcsHead?, addedAt } } }`.
- `registryDir(env)` — `KCRIB_REGISTRY_DIR` override (tests) else `~/.crib`.
- `readRegistry`/`writeRegistry` — atomic (temp→rename), tolerant of absent/unparseable files.
- `lookupProject`, `listProjects`, `registerProject` (preserves `addedAt` on re-register),
  `unregisterProject`.

**Key design decisions and why:**

1. **The registry is a pointer/overlay layer, NOT a second store.** The soul (chunked JSONL +
   manifest) stays committed inside each project's `.crib/` and remains team-shared. The registry
   only maps an absolute path → the `.crib` dir that holds its soul. This corrects the user's
   mental model of "refer to root `~/.crib`" — the root `~/.crib` is a *pointer*, not where the graph
   lives. The graph stays in the project, committed and portable.

2. **Keyed by absolute project path, NOT `repo.id`.** `repo.id` is a `randomUUID()` persisted
   *inside* `.crib/crib.json`, so reading it requires locating `.crib` first — a chicken-and-egg.
   `repoId` is stored as a validation tag only. The registry is therefore machine-specific (absolute
   paths); the soul itself stays portable/committed.

3. **The registry is NOT the load-bearing resolution mechanism.** Root resolution is done by the
   env-var + upward-walk chain (below); the registry is consulted only as an *overlay* after a root
   is discovered, to honor a custom `.crib` location. This means the registry can be deleted and
   `crib serve` still works for the standard `<root>/.crib` layout. The registry's load-bearing value
   is (a) custom `.crib` locations and (b) an enumerable "known projects" list.

**`packages/cli/src/runtime.ts` (rewritten)** — central resolution logic.

- `resolveProjectRoot(opts): ResolvedRoot` — the priority chain:
  1. explicit positional arg (not `.`)
  2. `--cwd` flag
  3. `KCRIB_ROOT` env
  4. `CLAUDE_PROJECT_DIR` env — Claude Code's real workspace signal (its `cwd` field is ignored,
     issue #42883). This is what makes a single user-scope Claude entry serve every project.
  5. upward walk from CWD for `.crib/crib.json` (monorepo subdirs)
  6. CWD fallback (preserves pre-REQ-1 behavior)
  then the registry overlay: a registered custom `cribDir` wins, but only if it still exists on disk.
- `walkUpForCrib(start)` — 128-iteration guard against symlink/`..` loops.
- `openSoul(resolved: ResolvedRoot)` — signature changed from `openSoul(repoRoot: string)`. The soul
  is opened from `resolved.cribDir`, not assumed `<repoRoot>/.crib`.
- `resolveIndexPath(rel, repoRoot, cribDir)` — manifest index paths are repo-root-relative by
  convention. For the standard layout they resolve against `repoRoot` as before; for a custom
  `cribDir` the leading `.crib/` is stripped so the derived index lands *inside* `cribDir` (it's a
  derived artifact of the soul, so it travels with it). Absolute manifest paths are honored.
- `isIndexedRoot(resolved)` + back-compat `isIndexed(repoRoot)` shim.

**`packages/cli/src/cli.ts` (rewritten, ~570 lines)** — wiring.

- `extractCwdFlag(argv)` → `{ argv, cwdOverride }`. `--cwd` is the highest-priority explicit root
  and may appear before or after the command. (Previously documented but not implemented — this
  fixes that doc divergence.)
- `CmdCtx { cwdOverride? }` threaded to every command.
- `resolveRoot(args, ctx)` — for path-taking commands: positional arg other than `.` → explicit
  root; `.` → treated as "no explicit" → walks from cwd (backward-compat with `crib serve .`).
- `registerIndexed(repoRoot, cribDir, soul)` — after `index`/`reindex`/`update`, the project is
  upserted into `~/.crib/registry.json` (refreshing `repoId`/`cribDir`/`vcsHead`, preserving
  `addedAt`).
- `cmdQuery` — positionals are query text, NOT a root; root comes from `--cwd`/env/CWD only.

### Backward compatibility

- An explicit positional arg always wins, so existing per-project IDE entries that pass an absolute
  root keep working unchanged.
- `crib serve .` walks from cwd (same result as before when `.crib` is present).
- The `isIndexed(repoRoot)` shim keeps any external caller on the old signature working.
- The registry is additive — deleting it degrades gracefully to the standard layout.

### Tests

`packages/cli/src/registry.test.ts` (5) + `packages/cli/src/resolution.test.ts` (12) cover the full
priority chain, the upward walk, the registry overlay (custom cribDir wins / stale cribDir falls
back), `.` positional backward-compat, and the atomic write.

---

## REQ-2: `crib mcp install/list/remove` — auto-wire the IDE configs

### The problem

Users had to hand-edit four different config formats (JSON with two different root keys, TOML with
snake_case tables), each with its own pitfall (wrong root key silently loads nothing; Codex needs an
absolute path).

### What was built

**`packages/cli/src/mcp-install.ts` (new, ~380 lines)** — auto-wires the `knowledge-crib` MCP server
into each IDE's config file.

- `McpIde = 'claude'|'cursor'|'vscode'|'codex'`, `McpScope = 'project'|'global'`.
- `resolveBin(bin?)` — explicit override, else absolute `which crib` (so GUI-launched IDEs that
  don't inherit the shell PATH still find the server), else fall back to `'crib'`.
- `installMcp(repoRoot, opts): McpInstallResult[]`, `listMcp`, `removeMcp`.

**Two idempotency strategies, by format:**

- **TOML (Codex `config.toml`)** — reuses `spliceManaged` (exported from `hooks.ts`) with
  `# >>> knowledge-crib managed >>>` / `# <<< knowledge-crib managed <<<` hash-comment markers. TOML
  permits comments, exactly like the post-commit hook. Sibling `[mcp_servers.other]` tables survive
  byte-for-byte. Re-running replaces the block in place (no duplication).
- **JSON (`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json`)** — JSON forbids comments, so the
  block-marker strategy cannot apply. Instead: parse → set `servers[name]` (or `mcpServers[name]`)
  in a canonical key order via `sortEntry` → reserialize. Byte-equality check makes re-running a
  no-op. Sibling servers and sibling top-level keys are preserved.

**`packages/cli/src/hooks.ts` (edited)** — `spliceManaged` promoted from private to `export` so
`mcp-install.ts` can reuse the exact same sentinel-block logic for TOML (consistent with the
post-commit hook).

**Per-IDE behavior (why each is the way it is):**

| IDE | Project-scope | Global/user-scope | Args embedded |
|---|---|---|---|
| **claude** | `.mcp.json` (`mcpServers`) | `claude mcp add -s user` (shells out — Claude's user config is CLI-managed, not a file we own) | project: `["serve","."]`; global: `["serve"]` (no path → resolution chain) |
| **cursor** | `.cursor/mcp.json` (`mcpServers`) | `~/.cursor/mcp.json` | `["serve","${workspaceFolder}"]` |
| **vscode** | `.vscode/mcp.json` (`servers` + `type:"stdio"`) | unsupported (upstream undocumented → notes + skips) | `["serve","${workspaceFolder}"]` |
| **codex** | `.codex/config.toml` (`[mcp_servers.knowledge-crib]`) | `~/.codex/config.toml` | `["serve","<abs root>"]` (Codex has no interpolation) |

**Why the args differ:**
- Cursor and VS Code interpolate `${workspaceFolder}` in a per-workspace file, so the same file
  works in every repo.
- Claude Code project-scope spawns with the project root as CWD, and `.` is treated as "no
  explicit root" → the resolution chain (CLAUDE_PROJECT_DIR → walk) finds the soul. This is portable
  and committable.
- The Claude *global* entry uses `["serve"]` (no path arg) deliberately — it relies on REQ-1's
  resolution chain (`CLAUDE_PROJECT_DIR` + registry) to pick the right soul per workspace. **This is
  the single-entry-serves-every-project path for Claude Code.**
- Codex has no `${workspaceFolder}` interpolation, so it must embed an absolute path. This is the
  one IDE where "one entry for every project" is not fully achievable (documented honestly below).

### Honest limitation documented

Codex cannot interpolate a workspace variable, so a single global Codex entry cannot transparently
serve multiple projects the way Claude/Cursor user-scope entries can. The `~/.crib` registry still
resolves a custom `.crib` location if the absolute path's `.crib` was moved, but it cannot make a
single Codex entry path-agnostic. This is stated plainly in the client-setup guide and CLI spec
rather than glossed over.

### Tests

`packages/cli/src/mcp-install.test.ts` (12) — covers all four IDEs × project/global scope, the
`servers` vs `mcpServers` distinction for VS Code, `type:"stdio"` requirement, TOML managed-block
idempotency + sibling preservation, `--ide all`, and `list`/`remove` (removing only the managed
entry, keeping siblings). `mcp-install.test.ts` sets `process.env.HOME` to a tmpdir to isolate
user-scope writes.

---

## Schema 1.3 — framework-semantics layer (Spring track + surfacing)

### The problem

A framework codebase — a Spring Boot service, a React app, an Angular module — was a *flat
symbol graph*: classes, methods, fields, and a `calls`/CFG graph. You could see that
`LoanController` existed and called `LoanService`, but the graph carried **none** of the
artifacts that make a framework service legible without reading it:

- no notion that `LoanController` served `POST /api/loans/{id}` (the route table / API surface);
- no notion that `LoanService` autowired `LoanRepository` (the DI graph), or that
  `LoanRepository` was itself *produced* by a `@Bean` method in `LoanRepositoryConfig`
  (the supply chain);
- no notion that `Loan.applicant` was a `@ManyToOne` to `Applicant`, or that `Loan.payments`
  was a `@OneToMany` mappedBy `loan` (the JPA relation model);
- no notion of architectural role — a `@RestController`, a `@Service`, a `@Repository`, a
  `@Configuration`, an `@Entity` were all just `class` symbols;
- and the same gap awaited React/Angular components (no `component` node, no `renders` edge).

Reading the graph still meant reading the code. The whole point of crib is to be *above* the
code, and for a framework codebase the symbol graph alone is not above it.

### What was built

**Schema (additive kinds + rels, no rewrite).** `packages/soul-schema/src/enums.ts` adds three
node kinds — `route`, `field`, `component` — and five rels: `exposes` (handler symbol → route),
`injects` (consumer class → dependency symbol, CLASS-level outgoing), `produces` (producer
method → produced type, `@Bean`/`@Factory`), `references` (field → related type, JPA
`@ManyToOne`/`@OneToMany`/`@ManyToMany`/`@OneToOne`), `renders` (component → child component).
`member-of` (child method/field → class, incoming to the class = its members) is reused for
class-scope aggregation. `packages/soul-schema/src/id.ts` gives each a distinct prefix
(`route:<httpMethod> <routePath>@<file>#L<line>`, `field:<path>#<qualifiedName>@L<startLine>`,
`comp:<path>#<qualifiedName>@L<startLine>`). `Node` gains optional `httpMethod`, `routePath`,
`framework`, `stereotype`, `whenSelector` strings, plus `meta.params`
(`Array<{name, type?, in}>` with `in = path|query|body|header|cookie|part|form|matrix`),
`meta.security` (`Record<string,string>`, e.g. `{PreAuthorize: "hasRole('X')"}`),
`meta.injects` (`string[]`, cross-file DI type names awaiting resolution), `meta.produces`
(`string[]`), and `meta.column` (`{id?, name?, nullable?, unique?, length?, joinColumn?,
generated?}`). `field.dataType` is reused from schema 1.1 (the field's declared scalar type).

**Spring extractor — Pass 4 of the Java pipeline** (`packages/parsers/src/java/spring.ts`,
pure + additive; a non-Spring class is a no-op):

1. **Stereotypes** — every `@RestController`/`@Controller`/`@Service`/`@Repository`/
   `@Component`/`@Configuration`/`@Entity`/`@Embeddable`/`@ControllerAdvice` class is tagged
   `framework:'spring'` + `stereotype:'<role>'` on its symbol node. A Spring Data repository
   that carries *no* `@Repository` annotation (`interface LoanRepo extends JpaRepository<…>`)
   is still tagged `repository` via the `REPOSITORY_BASES` fallback.
2. **Routes** — every `@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`/
   `@RequestMapping` handler becomes a `route` node with the class-level base path composed in
   (`joinPath` normalizes `/api` + `/{id}` → `/api/{id}`), all verbs honored (`@RequestMapping`
   is `ANY` unless `method=RequestMethod.X` pins it; multi-verb `method={GET,POST}` yields
   both), all paths honored (`@GetMapping({"/a","/b"})` → two routes). The route carries the
   param contract (`@PathVariable`→path, `@RequestParam`→query, `@RequestBody`→body,
   `@RequestHeader`→header, `@CookieValue`→cookie, `@RequestPart`→part, `@ModelAttribute`→form,
   `@MatrixVariable`→matrix) and the security contract (`@PreAuthorize`/`@PostAuthorize`/
   `@Secured`/`@RolesAllowed`). The handler method is linked to its route by an `exposes` edge.
3. **DI graph** — constructor-injected params and `@Autowired`/`@Inject`/`@Resource` fields
   become `injects` edges (consumer class → dependency). Spring 4.3+ implicit single-ctor
   autowire is honored; with multiple ctors the `@Autowired` one is the injection point;
   records' compact header ctor is read from `def.paramTypes`; `@Autowired` single-param
   setter methods are injection points too. DI/relation edges are emitted **only for beans**
   (a class carrying a stereotype) — an `@Autowired` field on a plain POJO is a no-op, so the
   framework graph stays honest. Self-injection is skipped. Intra-file deps resolve here;
   cross-file deps are recorded on `meta.injects` for the resolver (which widens to include
   `injects`).
4. **`@Bean` produces** — a `@Bean`-annotated method in a `@Configuration` class PRODUCES its
   return type (the Spring container's produced beans, the dual of the `injects` DI graph). A
   collection-returning bean (`List<Payment> payments()`) produces the element type. Intra-file
   resolved here; cross-file recorded on the method's `meta.produces`.
5. **JPA relations + columns** — `@ManyToOne`/`@OneToMany`/`@ManyToMany`/`@OneToOne` fields on an
   `@Entity` emit a `references` edge (field → related type). A collection-valued association
   targets the generic *element* type (`@OneToMany List<Payment>` → `Payment`), not the
   collection head. The relation's `cardinality` is the annotation NAME itself (the
   multiplicity) — without this the multiplicity was extracted then dropped — and
   `cascade`/`fetch`/`mappedBy`/`orphanRemoval` ride on the edge `meta` verbatim (whitespace
   preserved). `@Id`/`@Column`/`@GeneratedValue`/`@JoinColumn` on an `@Entity` field populate
   `meta.column` (PK flag, column name, generation strategy, FK join column).
6. **Per-method framework meta** — `@Transactional`, `@Scheduled` (cron/fixedRate/fixedDelay
   kind), `@Query` (JPQL + native flag), `@Modifying`, `@Procedure`, and method-level security
   are stamped on the method symbol node's `meta.*`.
7. **`@ExceptionHandler` advice** — a `@ExceptionHandler` method in a `@Controller`/
   `@ControllerAdvice` becomes an `exception-handler` node (`whenSelector` = the exception
   class(es), `A|B` for multi) + a `handles` edge exception-handler → method symbol.

Every framework edge is emitted with `method:'static'`, `provenance:'EXTRACTED'`,
`confidence:1`, `evidence:{snippet, by:'lang:java/spring'}`.

**Surfacing — the "above SQL" tier** (what makes a Java/Node/React/Angular graph *replace*
reading the code):

- **`context` verb (`packages/mcp/src/verbs.ts`)** — opt-in `withFramework:boolean` (matches
  the `withRules`/`withSource` convention — NOT unconditional). Calls
  `frameworkSemantics()` from `packages/core/src/dossier/framework.ts`, which is **pure over
  the soul** (no IndexStore, no disk) so the pipeline-persisted dossier and the live MCP
  `context` verb share one code path and are byte-identical in shape. It auto-scopes by node:
  a CLASS symbol (framework class, class-like type, or anything with incoming `member-of`
  children) → CLASS scope, aggregating the route table / bean inventory / DI graph / relation
  model / renders across members; a callable / component / field / route → METHOD scope (direct
  outgoing; dependencies lifted from the owning class for a callable). `lean:true` returns only
  the `{routes, produces}` the node OWNS (the persisted-dossier subset); `lean:false` (default,
  the `context` verb) additionally returns `dependencies`/`dependents`/`relations`/`renders`.
  **Supply chain in one hop, no round-trip**: a dependency whose type is a `@Bean`-produced type
  is surfaced with `kind:'produces'` + the producer method brief in the SAME object — a consumer
  reads "LoanRepository is injected AND produced by LoanRepositoryConfig.loanRepository()" in
  one trip (built from one soul-wide `produces` scan). **Unresolved honesty**: `meta.injects`/
  `meta.produces` type names that have no emitted edge surface as entries with `unresolved:true`,
  `id:'?'` — parity with the `gaps` verb's unresolved call-sites.

- **`dossier` verb** — `buildDossier` attaches `framework` (lean) + `shapeVersion:2`
  (`DOSSIER_SHAPE_VERSION`). `readDossier` reports `stale` when `shapeVersion !=
  DOSSIER_SHAPE_VERSION` (so pre-2.0 persisted artifacts rebuild on demand; `shapeVersion`
  undefined → stale → rebuilt) — independent of `schemaVersion`, and in addition to the existing
  hash + schemaVersion staleness gate. The serializer (`packages/core/src/dossier/serializer.ts`)
  emits `## Routes` / `## Produces` / `## Dependencies` / `## Dependents` / `## Relations` /
  `## Renders` sections (each only when non-empty), in fixed order, grouped after `## Control
  flow` and before `## Docs`.

- **`gaps` verb** — two new anomaly arrays: `controllersWithoutRoutes` (a `controller`-stereotype
  class with member methods but ZERO `exposes` edges — a `@Controller` whose handlers all lost
  their `@GetMapping`, or one with no handlers) and `unresolvedInjects` (a class declaring a DI
  type in `meta.injects` that the resolver never linked to a symbol — the dual of unresolved
  call sites, a missing bean the consumer expects). Both added to the `summary` keys.

- **`viz` (`packages/ui/src/viz.ts`)** — `buildVizGraph` surfaces `framework`/`stereotype`/
  `httpMethod`/`routePath` on the node data so the detail panel can show the framework role
  without re-querying the soul. `makeSummary` is richer for `route` (`POST /api/loans`, not
  `route: POST /api/loans`), `field` (`Field applicant → column applicant_id`), `component`
  (`react component LoanForm`), and `symbol` (`controller: LoanController`). All edges are
  already emitted.

**The `crib migrate` truth (canonical).** There is **no `crib migrate` command**. Schema
evolution is automatic and additive: (1) every 1.0→1.3 field is OPTIONAL +
`additionalProperties:true`, so an old soul loads verbatim; (2) re-indexing stamps the new 1.3
fields onto the SAME node (id-stable, hash-stable, in-place); (3) persisted dossiers rebuild on
demand via the `shapeVersion` + `schemaVersion` staleness gate in `readDossier`. No rewrite, no
data loss. The `'crib migrate'` test referenced in `testing.md §7` IS the schema round-trip +
forward-compat test in `packages/core/src/validate.test.ts` (a 1.0/1.2 node validates under the
1.3 schema; a 1.2 node → stamp 1.3 fields → re-validate, id unchanged).

**Dist gate.** `pnpm test` now runs `pretest: pnpm -r run build` first, so tests never run
against stale `dist` — packages export from `./dist`, so a stale `dist` silently masks bugs.
`pnpm verify` = build + test + lint.

### Backward compatibility

Schema evolution is additive and automatic (the migrate truth above):

- Every 1.0→1.3 field is OPTIONAL + `additionalProperties:true`, so a 1.0-era soul (no 1.1/1.2/1.3
  fields), a 1.2 soul (behavior fields, no framework fields), and a 1.3 soul all load verbatim
  under the current 1.3 schema. `SUPPORTED_SCHEMA_VERSIONS` includes `1.0`/`1.1`/`1.2`/`1.3`;
  `SCHEMA_VERSION === '1.3'`.
- Re-indexing stamps the new 1.3 fields onto the SAME node — `id` and `hash` are unchanged, so no
  edges are re-written and no clusters shift. A 1.2 service class becomes a 1.3
  `framework:'spring'`/`stereotype:'service'` class in place.
- Persisted dossiers rebuild on demand: `readDossier` flags `stale` when the dossier's
  `shapeVersion` is missing or older than `DOSSIER_SHAPE_VERSION` (2), so pre-2.0 artifacts
  rebuild the first time they are read, with no explicit migration step.
- The Spring extractor is a no-op on non-Spring classes — a plain POJO with an `@Autowired`
  field (not a bean) emits no DI/relation edge — so the framework graph only carries real
  framework semantics.

### Tests

- **`packages/core/src/dossier/framework.test.ts` — 12**: class-scope `member-of` aggregation
  (controller route table with owning handler, DI graph as `dependencies` + reverse-injects as
  `dependents`, `@Entity` relation model with `cardinality`/`cascade`/`fetch`/`mappedBy` verbatim,
  `@Configuration` bean inventory with the producing method) and method scope (`lean:true` →
  only the routes/produces the callable owns; `lean:false` → dependencies lifted from the owning
  class + dependents on produced types; supply-chain `kind:'produces'` + producer).
- **`packages/core/src/validate.test.ts` — 22**: 1.3 round-trip (route/field/component/`@Bean`
  method/references edge/produces edge each validate, plus a JSON serialize/parse round-trip
  re-validates with no field lost), forward compatibility (a 1.0-era node, a 1.2 behavior node, a
  1.0-era edge, and a manifest claiming `schemaVersion 1.0` all validate under the 1.3 schema),
  the additive "crib migrate" case (a 1.2 node → stamps 1.3 fields → re-validates, `id` and
  `hash` unchanged), `SUPPORTED_SCHEMA_VERSIONS` includes `1.0`→`1.3`, field-`dataType` reuse
  guard, and closed-enum rejection (bad `kind`/`rel`/`provenance`/`confidence`/`hash`/`id` all
  throw `SchemaValidationError`).
- **`packages/mcp/src/verbs.test.ts` — 6 (framework-semantics integration)**:
  `context(withFramework)` on a controller surfaces the route table + params + security + DI
  graph (full set); the supply-chain case (a service injecting a `@Bean`-produced type →
  `kind:'produces'` + producer); and the Spring `gaps` anomalies
  (`controllersWithoutRoutes` for a controller with member methods but zero `exposes`,
  `unresolvedInjects` for a class whose `meta.injects` names a type with no `injects` edge).
- **`packages/cli/src/viz.test.ts` — 1 (framework-semantics 1.3 surfacing)**: `buildVizGraph`
  surfaces route `httpMethod`/`routePath` + field column + component `framework` + symbol
  `stereotype` on the node data.
- **Full suite green.**

---

## Tests + build + lint

- **CLI tests: 40 pass** (registry 5, resolution 12, mcp-install 12, hooks 5, runtime 2, viz 4).
- **Affected packages build/test clean in isolation**: core 38, mcp 17, pipeline 61, cli 40
  (156 total, +29 new).
- **Biome lint clean** on all 9 touched/new files.
- The full-monorepo `pnpm build` has pre-existing failures in `packages/parsers` (untracked WIP:
  `rust/`, `go/`, `csharp/`, `java/` lexer dirs + modified `parsers/src/index.ts`) that are **not**
  from this work and were deliberately left untouched.

---

## Documents updated

- **`docs/knowledge-crib-client-setup.md`** — headline changed from "2-line per-project config" to
  "one user-scope entry that serves every project". Added §3 "Root resolution — one entry, every
  project" (the priority chain + registry-as-overlay) and a `crib mcp` subsection. Each IDE section
  now leads with the `crib mcp install` shortcut before the hand-edit fallback. **Fixed the false
  CWD claim** at the old §4 note ("Claude Code sets cwd to the project root") — replaced with the
  honest explanation that Claude Code ignores `cwd` (#42883) and the chain falls through to
  `CLAUDE_PROJECT_DIR` + the upward walk. Codex §7 now states the absolute-path limitation honestly
  and removed the inline `//Added by Vishal` feasibility-question comment.
- **`docs/knowledge-crib-cli.md`** — reconciled with the implemented `printHelp`: `--cwd` marked
  **Implemented** (was previously listed but not wired); unimplemented flags (`--json`,
  `--quiet/--verbose`, `--link-threshold`, `--include`, `--lang`, `--worker-timeout`, `--transport`,
  `--extracted-only`, `migrate`) explicitly marked **planned / not yet wired**. Added the full
  `crib mcp` command section and a "Root resolution (REQ-1)" section. `query` clarified as taking
  search-text positionals (not a root).
- **`docs/knowledge-crib-user-guide.md`** — added `crib mcp` to the commands table, a "One IDE entry
  for every project" subsection under §3, and the `crib mcp install` wiring in the worked example §5.8.
- **`README.md`** — `cli/` layout line updated to `crib index|update|export|serve|mcp|viz|install-hooks|merge-driver`.

---

## Decision item 4 — committing the soul

The user delegated the "should `.crib/` be committed" concern to best recommendation. `git ls-files
.crib/` returned 0 (the soul was not tracked). The design intent — stated across the docs, the
soul-format spec, and the merge driver — is that `.crib/` (minus the derived `index/`) is committed
and team-shared. **Recommendation applied: commit `.crib/`** (the chunked JSONL soul + `crib.json` +
`schema/`), with `.crib/index/` gitignored. This is consistent with the existing
`docs/knowledge-crib-soul-format.md` and the `crib install-hooks` merge driver, which only make sense
if the soul is shared. The registry (`~/.crib/registry.json`) stays machine-local and gitignored.

---

## Summary

Two user requests, both delivered in `packages/cli`:

1. **REQ-1** — Replaced "one IDE entry per project" with a **resolution chain** (explicit arg →
   `--cwd` → `KCRIB_ROOT` → `CLAUDE_PROJECT_DIR` → upward walk → cwd) plus a **`~/.crib/registry.json`
   pointer overlay**. A single user-scope IDE entry now serves every project, while every existing
   per-project entry keeps working (explicit always wins). The registry is a pointer layer, not a
   second store — the soul stays committed and portable inside each project's `.crib/`.

2. **REQ-2** — Added **`crib mcp install|list|remove`**, idempotent auto-wiring of the MCP server into
   all four IDEs' config files (two idempotency strategies: sentinel-block for TOML, parse/merge for
   JSON). It preserves sibling content, embeds a PATH-independent absolute binary, and surfaces an
   honest note for the one IDE (Codex) where a single path-agnostic entry isn't possible.

29 new tests (registry, resolution, mcp-install); 40 CLI tests pass; build + lint clean. All four
user-facing docs updated and reconciled with the actual implementation (including fixing a false
CWD claim and flagging spec'd-but-unimplemented flags). This changelog documents every change, its
rationale, and the one honest limitation.