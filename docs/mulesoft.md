# MuleSoft extraction

Knowledge-crib ships a **built-in MuleSoft extractor** that turns a Mule integration project into the
same deterministic node/edge "soul" every other language produces — so a MuleSoft→Java migration can
be reasoned about with the same `query` / `impact` / `context` / `dossier` verbs as Java, TypeScript,
or PL/SQL. It is an **extractor, not a Java generator**: it indexes what is there, it does not emit
target Java code (see [Non-goals](#non-goals)).

Both **Mule 3** and **Mule 4** are supported, side by side as independent projects in one input.

---

## Indexing a Mule project

```bash
# A source folder (your checked-out Mule app)
crib index ./my-mule-app

# A exported project ZIP
crib index ./sapi-billing.zip

# A deployable Mule JAR (attached source under META-INF/mule-src wins over a packaged classes/ copy)
crib index ./target/my-app-mule-application.jar

# Index into an explicit .crib instead of <input>/.crib (useful for archives / CI)
crib index ./my-mule-app --crib-dir /tmp/soul
```

`crib index <dir>` indexes in place; the soul lands at `<dir>/.crib`. `crib index <archive>` extracts
once into a content-addressed cache and indexes the extracted tree — the archive itself is never
mutated and never needs to sit beside a `.crib`.

### Archive cache

Archives (`.zip` / `.jar`) extract once into a cache, then index the extracted tree:

```
~/.crib/imports/<sha256(resolve(path))>/source    ← extracted tree (the sourceRoot)
                          /crib                  ← per-archive .crib (the soul lives here)
                          /input.json            ← fingerprint manifest (cache-hit check)
```

- The directory hash is over `resolve(path)` (the absolute path), so the same archive at the same
  path reuses its cache.
- A **cache hit** requires a matching **fingerprint** — SHA-256 of the archive *bytes*. Editing the
  archive (even at the same path) invalidates the cache and triggers a fresh extract + full re-index;
  an unchanged archive is a no-op.
- Override the cache root with `KCRIB_IMPORTS_DIR=/some/where crib index ./app.zip` (useful in CI to
  keep the cache on ephemeral storage).
- `--crib-dir` overrides where the soul is written (default `<cache>/crib` for archives,
  `<input>/.crib` for directories).

### Updating

```bash
crib update ./my-mule-app        # directory: VCS delta (git --since / --dirty)
crib update ./sapi-billing.zip   # archive: fingerprint compare
```

- **Directory**: normal git-delta update (`--since <ref>`, `--dirty` for uncommitted changes).
- **Archive**: `crib update` compares the current archive fingerprint to the registered one.
  Unchanged → `up to date (archive unchanged)`. Changed → `archive changed — re-indexing` (a fresh
  archive has no incremental anchor, so it degrades to a full re-index and re-registers the new
  fingerprint).
- **`--since` / `--dirty` are rejected for archive inputs** — archives have no git work tree, so a
  git delta is meaningless. Re-run `crib index <archive>` to refresh.
- **`--watch` is rejected for archive inputs** for the same reason.

---

## Mule 3 vs Mule 4 detection

Mule 3 and Mule 4 share an XML vocabulary, so dialect is **scored**, not guessed. Per file, strong
signals accumulate:

| Signal | Dialect | Weight |
|---|---|---|
| `mule-artifact.json` descriptor | Mule 4 | +3 |
| `src/main/mule/` layout | Mule 4 | +2 |
| `src/test/munit/` layout | Mule 4 | +2 |
| `mule-project.xml` descriptor | Mule 3 | +3 |
| `src/main/app/` layout | Mule 3 | +3 |
| `<packaging>mule-domain</packaging>` (pom) | Mule 3 | +2 |
| Legacy transport namespaces / `<endpoint>` / `<exception-strategy>` | Mule 3 | +2 |

A project root is anchored by a descriptor (`mule-artifact.json`, `mule-project.xml`, `pom.xml` with
`mule-application`/`mule-domain` packaging, or `mule-deploy.properties`). Each file is routed to the
dialect that wins its project. **Conflicting signals** (both dialects present and within 2 points)
emit a `mule:ambiguous-dialect` **error** diagnostic and the file is not semantically extracted — the
rest of the project remains queryable. A Mule 3 root and a Mule 4 root side by side are classified as
**independent projects**, not a conflict.

### Deployable JAR: attached source wins

A deployable Mule JAR carries the canonical config under `META-INF/mule-src/...` (attached source)
and often a packaged duplicate under `classes/...`. They describe the same project-relative file:
**attached source wins**; the packaged duplicate is skipped with a single bounded
`mule:packaged-duplicate-skipped` warning so the topology is not double-counted.

---

## What is extracted

Every construct below becomes first-class graph nodes + edges (intra-file in the extractor,
cross-file in the resolver), queryable with the standard verbs.

| Construct | Graph representation |
|---|---|
| `<flow>` / `<sub-flow>` | `flow` / `subflow` nodes |
| `<flow-ref>` | `statement` (semanticKind `flow-ref`); resolver links to the target flow, or to an **`external-flow` placeholder** when the target is unresolved |
| `<choice>` / `<when>` / `<otherwise>` | `statement` (semanticKind `router`, operation `choice`) |
| `<ee:transform>` + `<ee:set-payload>` | `statement` (semanticKind `transform`); one statement per element (see [One element per line](#one-element-per-line)) |
| Inline DataWeave `#[...]` | counted as a source-text metric (`inlineDw2`), not graph nodes |
| `<http:listener>` (first processor) | `route` (semanticKind `source`) — a flow's message source |
| RAML `/resource` methods | `route` (lang `raml`) — APIKit operations |
| `<http:request>` / outbound transports | `http-call` / outbound call nodes |
| `<error-handler>` / `<on-error-*>` | `exception-handler` nodes |
| `.dwl` modules | `module` (lang `dataweave`); split into production (`src/main/`) vs test (`src/test/`) |
| MUnit `<munit:test>` | `test` nodes |
| MUnit `<mock:when>` / `<mock:verify>` / assertions | `statement` (munitKind `mock` / assertion) |
| Descriptors (`mule-artifact.json`, `pom.xml`, `*.properties`) | `descriptor` / `property` nodes (keys only — see [Properties & secrets](#properties--secrets-keys-only)) |

### MUnit semantics

MUnit test files (`src/test/munit/*.xml`) are indexed as first-class `test` nodes. Each `<munit:test>`
carries its behavior (mocks), execution (the flow-ref under test), and assertions as statement nodes,
so a migration can answer "which production flow does this test exercise, and what does it mock?" via
normal `context` / `impact` walks. Mock processors (`<mock:when ...>`) are tagged `munitKind: 'mock'`.

### Unresolved placeholders

A `<flow-ref name="..."/>` whose target does not exist anywhere in the indexed input resolves to an
**`external-flow` placeholder node** rather than a dangling edge. This makes missing/private flows
visible in the graph instead of silently dropped — useful when a Mule app references a domain or
shared library that was not part of the indexed artifact.

### One element per line

Statement nodes are keyed by **start line**. Two statement-kind elements on the *same* XML line
collide to one id (the child overwrites the parent in the deterministic store). The extractor handles
this correctly for normal Mule output (each processor is on its own line), but be aware: hand-edited
config that crams `<choice>` and its inner `<logger>` onto one line, or `<ee:transform>` and its
`<ee:set-payload>` onto one line, will drop the parent statement. Keep one Mule element per line.

---

## Properties & secrets (keys only)

**Locked constraint: properties and secrets are indexed as KEYS AND REFERENCES ONLY — never values.**

- **Ordinary properties** (`application.properties`, `app.properties`): each key becomes a `property`
  node; the **value is never stored** (not in the node, not in the searchable body, not hashed).
- **Sensitive-named files** (`secure.properties`, `*credentials*`, `*keystore*`, `*secret*`,
  encrypted/`*.encrypted` files, key/trust stores): the keys are recorded as **redacted references**
  (`meta.valueRedacted: true`); the secret **value never enters the graph** — not the node, not the
  snippet, not the FTS body, not a hash.
- **Secure/encrypted property files and key/trust stores** get a source policy **deny**: never read
  from disk, never persisted, never hashed by value. A `source` verb call on a denied resource
  returns no body.
- Mule config attributes that carry secrets (`password`, `secret`, `token`, `credential`,
  `private-key`) are redacted in place (`<redacted>`); `${...}` and `${secure::...}` property
  placeholders are kept (they are references, not values).

This means an indexed Mule soul is safe to commit and share even when the source project contained
credentials — the credentials are simply not in it. The local acceptance gate
(`scripts/check-mule-sample.mjs`) asserts this for every run: zero property nodes carry a raw value,
zero secret values appear anywhere in the graph.

---

## Diagnostics

Per-file diagnostics are aggregated during parse and surfaced in the index summary:

- `mule:ambiguous-dialect` (error) — conflicting Mule 3/4 signals; file skipped.
- `mule:packaged-duplicate-skipped` (warning) — a packaged `classes/` copy was shadowed by attached
  source in a deployable JAR.
- Parse failures degrade to a **file-level node** and a diagnostic — they never throw the pipeline,
  so one bad file does not block the rest of the project. **Index success does not depend on warning
  count**; error diagnostics for individual files are reported while the rest of the project stays
  queryable.

---

## Index summary

When a Mule project is detected, `crib index` appends a one-line Mule summary to its human output and
exposes the same numbers under a `mulesoft` key with `--json`:

```bash
$ crib index ./my-mule-app
indexed 42 files → 910 nodes, 1420 edges (18 describes, 39 references) · mule: 1 project (mule4: 30), 18 flows, 7 subflows, 10 routes, 39 flow-refs, 27 transforms, 6 munit tests, 3 unresolved in 480ms

$ crib index ./my-mule-app --json | jq '.mulesoft'
{
  "projects": 1,
  "dialectFiles": { "mule3": 0, "mule4": 30 },
  "flows": 18, "subflows": 7, "routes": 10,
  "flowRefs": 39, "transforms": 27, "munitTests": 6,
  "externalTargets": 3,
  "references": { "resolved": 36, "unresolved": 3 },
  "diagnostics": { "warnings": 0, "errors": 0 }
}
```

`--json` emits the **full index report** with `mulesoft` added and **no other top-level field
changed** (`files`, `parse`, `resolve`, `cfg`, `link`, … all stay). A non-Mule repo prints no Mule
segment and reports `"mulesoft": null`. Counts use the same predicates as the local acceptance gate
(`scripts/check-mule-sample.mjs`), so the summary and the gate agree.

`references.resolved` = `flowRefs` − `externalTargets`; each unresolved target counts as one
unresolved flow-ref (an approximation when several flow-refs share one missing target).
`routes` = message sources (`<http:listener>`) + RAML API operations.

---

## Local acceptance gate

`scripts/check-mule-sample.mjs` is a hermetic, license-safe checker that indexes a Mule project
(directory or archive) with the built CLI and asserts the extracted graph matches an exact topology
baseline, plus the two security canaries (no raw property values, no semantic nodes from report JS).
Its companion `scripts/fixtures/synthetic-mule-project.mjs` generates a deterministic synthetic Mule 4
app from scratch — no proprietary code — so the gate runs in CI without a real sample.

```bash
corepack pnpm@9.15.0 build
node scripts/check-mule-sample.mjs --archive /abs/path/to/mule-project-or-zip
```

A real project will differ from the synthetic baseline counts — the checker still prints its
measured table for human inspection and still enforces the two security canaries (which hold for any
project). The proprietary `sapi-billing` sample lives only on the operator's machine and is never
committed; the synthetic corpus is the CI acceptance truth.

---

## Non-goals

- **No Java generation.** The extractor indexes a Mule project as a graph; producing target Java /
  Spring Boot code is a downstream migration step performed by an agent or migrator consuming the
  graph, not by `crib index`.
- **No value extraction from secrets.** Credentials, keystores, and encrypted property values are
  never read or stored (see [Properties & secrets](#properties--secrets-keys-only)).
- **No git ownership for archives.** Archives have no work tree, so `--since` / `--dirty` / `--watch`
  are not supported for archive inputs (re-index to refresh).