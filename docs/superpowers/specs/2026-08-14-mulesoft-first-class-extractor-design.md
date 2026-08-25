# First-Class MuleSoft Extractor Design

- **Date:** 2026-08-14
- **Status:** Approved for specification; implementation requires a separate reviewed plan
- **Target:** Knowledge-crib parser, pipeline, CLI, graph, and test packages

## 1. Summary

Knowledge-crib will support MuleSoft as a built-in extractor family alongside Java and
TypeScript/Node. The feature accepts source directories, ZIP exports, and Mule JARs; detects Mule 3
and Mule 4 applications; extracts application behavior, API contracts, transformations,
configuration relationships, external dependencies, and MUnit evidence; and resolves those facts
into the existing language-neutral graph.

This is an extractor and indexer. It does not generate Java code, execute Mule applications, or
attempt to prove runtime-equivalent behavior.

The design is source-first and deterministic. It never invokes Mule, Maven, an LLM, or a network
service. Property references and key names are indexed, but property values, credentials, keystore
contents, and other secrets are not retained or made searchable.

## 2. Approved Product Decisions

The user approved these decisions during design:

1. Build a Knowledge-crib MuleSoft extractor, not a Mule-to-Java generator.
2. Support both Mule 3 and Mule 4.
3. Accept source directories, ZIP files, and Mule JARs.
4. Index MUnit tests, mocks, fixtures, and assertions as migration evidence.
5. Index property keys and references only; never retain secret values.
6. Ship the extractor in the default built-in fleet rather than as an external plugin.

## 3. Goals

### 3.1 Functional goals

- Detect one or more Mule applications or domains inside a directory or archive.
- Distinguish Mule 3 and Mule 4 deterministically and record ambiguous cases as diagnostics.
- Extract flows, subflows, processors, connector operations, configuration elements, imports,
  routers, conditions, error handling, transformations, sources, outbound calls, and property
  references with line-level provenance.
- Extract DataWeave 1/2 and MEL structure honestly: declarations, imports, expressions, call sites,
  and property/resource references without claiming compilation or type resolution.
- Extract RAML resources, methods, includes, types, traits, and APIKit mappings.
- Extract MUnit tests, tested flows, mocks, fixtures, assertions, and expected errors.
- Resolve local references across files and retain unresolved static references as explicit external
  placeholders.
- Feed the resulting graph through the existing linker, clustering, dossier, query, context, path,
  and impact features.
- Preserve deterministic IDs and byte-stable output across serial and concurrent parsing.

### 3.2 Operational goals

- Keep the default folder-indexing experience unchanged for existing languages.
- Make archive-backed source rehydratable after the indexing command exits.
- Reject unsafe archives before writing extracted entries.
- Degrade per file and per expression rather than failing a complete repository index.
- Report coverage and diagnostics by Mule project and dialect.

## 4. Non-goals

- Generating Spring Boot or other target-language source code.
- Running Mule Runtime, Maven, MUnit, DataWeave, or MEL.
- Downloading connector metadata or dependencies from Anypoint Exchange or Maven repositories.
- Decrypting secure properties or inspecting keystore/truststore contents.
- Evaluating dynamic flow names, dynamic imports, or runtime property precedence.
- Decompiling Java bytecode or proprietary connector binaries.
- Claiming full DataWeave/MEL type or runtime semantics.
- Committing the provided proprietary `sapi-billing` sample to the repository.

## 5. Architecture

```text
folder / ZIP / JAR
    -> input preparation and persistent source authority
    -> project-root and Mule-version detection
    -> file classification
    -> Mule XML / DW / MEL / RAML / MUnit / descriptor extraction
    -> Mule cross-file resolution
    -> existing link / cluster / dossier / index phases
    -> existing MCP and CLI query surfaces
```

### 5.1 `PreparedSourceInput`

A new pipeline input layer separates the user-facing project identity from the stable directory used
for source reads:

```ts
interface PreparedSourceInput {
  projectKey: string;       // canonical directory or archive path used by the registry
  sourceRoot: string;       // stable directory read by extractors and evidence rehydration
  cribDir: string;          // soul/index storage
  kind: 'directory' | 'zip' | 'jar';
  fingerprint: string;      // content fingerprint for archive refresh
  archivePath?: string;
}
```

Directory inputs retain the existing behavior: `projectKey === sourceRoot`, and `.crib` defaults to
`<sourceRoot>/.crib` unless `--crib-dir` redirects it.

Archive inputs use a path-keyed external workspace under the user crib directory:

```text
~/.crib/imports/<hash-of-canonical-archive-path>/
  input.json
  source/
  crib/
```

The path-based workspace identity remains stable when an archive is replaced. `input.json` records
the archive fingerprint, kind, canonical archive path, detected roots, and extractor version. A
changed fingerprint triggers atomic re-extraction and a full reindex. The expanded source remains
available for snippets, dossiers, FTS, and later MCP queries; it is not deleted after indexing.

The project registry gains optional `sourceRoot`, `sourceArchive`, and `sourceFingerprint` fields.
Resolving an indexed archive path returns its stable `sourceRoot` for reads and its external
`cribDir` for the soul. Directory registry entries remain backward compatible.

Archive inputs do not support Git-anchored incremental update, watch mode, or ownership attribution.
`crib update <archive>` compares fingerprints and either reports a no-op or performs a full reindex.

### 5.2 Archive safety

ZIP and JAR reading uses a lazy, pure-JavaScript ZIP reader and extracts through an atomic staging
directory. The implementation rejects:

- absolute paths, `..` traversal, NUL bytes, and platform-specific rooted paths;
- symbolic links and hard links;
- duplicate normalized destinations and case-folding collisions;
- more than 50,000 entries;
- a single expanded entry larger than 100 MiB;
- total expanded content larger than 2 GiB;
- suspicious compression ratios above 100:1;
- encrypted entries and unsupported compression methods.

Every destination is resolved and checked to remain below the staging root before opening it. A
failure removes the staging directory through the repository's recoverable/atomic cleanup helper and
leaves the previous source cache intact.

### 5.3 Project and dialect detection

Detection occurs after discovery and before extractor dispatch. It can identify multiple Mule
projects within a monorepo or expanded archive. Each file receives clone-safe classification data:

```ts
interface FileClassification {
  family: 'mule';
  projectId: string;
  projectRoot: string;
  dialect: 'mule3' | 'mule4';
  role:
    | 'config'
    | 'dataweave'
    | 'mel'
    | 'raml'
    | 'munit'
    | 'descriptor'
    | 'properties'
    | 'resource';
  sensitive?: boolean;
}
```

`FileMeta` gains an optional generic `classification` field so the default extractor fleet and
worker pool do not need direct access to the repository root.

Mule 4 strong signals include `mule-artifact.json`, Maven `mule-application` or `mule-domain`
packaging, `src/main/mule`, and Mule 4 namespaces/descriptors. Mule 3 strong signals include legacy
project/application descriptors, legacy source layouts, and Mule 3 schema namespaces. Descriptor and
packaging signals outrank path heuristics; namespaces validate rather than silently override a strong
project classification.

Conflicting strong signals generate an `ambiguous-dialect` error diagnostic. Ambiguous XML remains a
file node but is not semantically parsed until the conflict is resolved. Mixed Mule 3 and Mule 4
projects in one repository are supported when they occupy distinct detected project roots.

### 5.4 Parser family

The parser package adds these bounded units:

- `mule/xml`: namespace-aware XML tokenizer and shared Mule document AST;
- `mule/mule3`: Mule 3 element classification, transports, exception strategies, MEL, and DW1
  conventions;
- `mule/mule4`: Mule 4 sources, operations, routers, error handlers, APIKit, and DW2 conventions;
- `mule/dataweave`: DW1/DW2 declarations, imports, functions, expressions, and call sites;
- `mule/mel`: MEL expression tokenization and reference/call extraction;
- `mule/raml`: RAML resources, methods, types, traits, security schemes, and `!include` references;
- `mule/munit`: Mule 3/4 MUnit test, mock, assertion, and fixture semantics;
- `mule/descriptors`: POM, Mule descriptor, and key-only property parsing;
- `MuleExtractor`: dispatch and graph emission implementing the existing `Extractor` contract.

XML parsing uses the `saxes` package in namespace mode with DTD/entity rejection, line/column
tracking, and CDATA preservation. RAML parsing uses the `yaml` package with custom `!include`
handling and source-position retention. ZIP/JAR handling uses `yauzl` in lazy-entry mode with
explicit path, link, count, size, and ratio validation. All three dependencies require license
notices and packaging verification.

The shared XML AST is intentionally Mule-shaped rather than a generic DOM:

```ts
interface MuleDocument {
  dialect: 'mule3' | 'mule4';
  imports: MuleImport[];
  configurations: MuleConfiguration[];
  flows: MuleFlow[];
  diagnostics: ExtractDiagnostic[];
}

interface MuleFlow {
  name: string;
  kind: 'flow' | 'subflow';
  processors: MuleProcessor[];
  errorHandlers: MuleErrorHandler[];
  span: Span;
}
```

Processors retain namespace, local operation, semantic attributes, nested processors, expressions,
and spans. Only whitelisted semantic attributes are retained. Unknown attributes and attributes with
credential-like names are not serialized.

### 5.5 Resolver family

`MuleResolver` implements the existing pipeline `Resolver` contract. It builds project-scoped indexes
for flows, subflows, configurations, DataWeave functions/modules, RAML routes/types, properties, and
external dependency placeholders.

It resolves:

- `flow-ref` and equivalent Mule 3 references;
- `config-ref` and configuration names;
- XML `<import>` resources;
- DataWeave module/function imports and static calls;
- RAML includes, libraries, traits, types, and APIKit generated-flow names;
- property placeholders and `secure::` property references;
- MUnit tested-flow and mock targets;
- connector usage to POM/plugin dependencies when the namespace/artifact mapping is explicit.

Dynamic targets remain on their source node as expressions and increment a diagnostic/stat counter.
They never create guessed edges. Unresolved static references produce deterministic external
placeholder symbols and traversable edges rather than being dropped.

## 6. Graph Mapping

The design reuses schema 1.6. Mule-specific meaning is represented through open `type`, `framework`,
`stereotype`, and `meta` fields, so no schema-version bump is required.

| Mule construct | Node/edge representation |
|---|---|
| flow | `symbol(type='flow', lang='mule3|mule4')` |
| subflow | `symbol(type='subflow')` |
| processor/operation | `statement`, executed by the enclosing flow |
| static flow reference | flow `calls` target flow, plus call-site metadata |
| choice/when/otherwise | `condition`, `guarded-by`, branch metadata |
| transform/set payload/set variable | `statement` or `assignment` with bounded expression |
| DataWeave function/module | `symbol`, `imports`, `calls` |
| MEL expression | bounded expression and extracted call/property references |
| HTTP/APIKit listener | `route`, exposed by the handler flow |
| outbound HTTP request | `http-call`, executed by the flow |
| global connector configuration | `symbol(type='config', stereotype='config')` |
| error handler/strategy | `exception-handler`, `handles` |
| property key | `symbol(type='property')`; key only |
| Maven connector/module | external `symbol(type='dependency')` |
| MUnit test | `symbol(type='test')`, calling the tested flow |
| MUnit mock/assertion | test `statement`/`condition` and references |
| RAML resource/method | `route`; RAML type/trait becomes a symbol |
| unresolved flow/config/module | external symbol with `meta.external=true` |

Flow qualified names use project identity plus flow name:

```text
<project-id>::<flow-name>
```

Processor identity uses the containing flow, source line, namespace/local operation, and a stable
same-line ordinal. Processor order is retained in `meta.sequenceIndex`; nested scopes retain a
`meta.scopePath`. No new `next` relation is introduced.

For a static flow reference, the call graph edge connects the containing flow symbol to the target
flow symbol, matching how existing Java/TypeScript callers participate in impact analysis. The
flow-ref processor remains a statement so line-level reconstruction and ordering are preserved.

APIKit route extraction reconciles three facts where available: RAML method/path, APIKit generated
flow name, and listener base path. Unresolved property placeholders remain templated in the route
path. The extractor does not read property values to manufacture concrete routes.

## 7. Data Flow

1. The CLI canonicalizes the directory/archive input and prepares a stable source authority.
2. A bounded descriptor prepass identifies candidate Mule roots early enough to prune project-local
   generated directories during the full walk.
3. Discovery walks the stable source root while applying baseline, `.gitignore`, and Mule-generated
   exclusions.
4. Full Mule project detection assigns project, dialect, role, and sensitivity classifications.
5. Structure emits file nodes. Sensitive and value-redacted files are marked before any
   search/snippet ingestion.
6. The extractor registry dispatches classified Mule files to `MuleExtractor`.
7. Per-file extraction emits nodes, intra-file edges, call/reference metadata, and diagnostics.
8. `MuleResolver` emits project-scoped cross-file edges and external placeholders.
9. Existing CFG/link/cluster/dossier/index phases consume the graph without Mule-specific branches.
10. CLI/MCP reports expose per-project coverage, dialects, diagnostics, and unresolved dependencies.

The default extractor and resolver fleets register Mule append-only. The concurrent path receives
classification through `FileMeta`; the worker-thread path remains compatible because all
classification and result records are structured-clone-safe.

## 8. Discovery and Generated Noise

Mule classification adds project-local generated-directory exclusions:

```text
.mule/
reports/
target/
```

The existing universal `.git/` exclusion remains. Exclusions apply only where the detector has
identified a Mule project, avoiding a global behavior change for repositories that intentionally use
directories named `reports`.

Nested `src/main/mule` folders remain supported. For packaged Mule 4 JARs, configuration XML at the
archive root and source under `META-INF/mule-src` are classified using the descriptor and packaged
layout. When both packaged and attached source copies exist, attached source wins and packaged
duplicates are recorded as skipped diagnostics.

## 9. Secrets and Sensitive-Source Policy

### 9.1 Classification

A file is sensitive when any of these are true:

- it is a keystore, truststore, certificate bundle with private material, or known credential store;
- its name/path matches secure-property conventions;
- a Mule secure-configuration element identifies it as encrypted/secure input;
- bounded content sniffing identifies private-key or credential-store headers.

### 9.2 Storage and search

- Sensitive binary contents are never parsed, indexed, included in dossiers, or exposed as snippets.
- All classified configuration-property files, secure or ordinary, are marked
  `meta.valueRedacted=true`; their body text never enters FTS, dossiers, semantic inputs, logs, or
  persisted diagnostics.
- Property parsers emit key names only and discard values immediately.
- Property-symbol hashes are computed from project ID plus key name, never from a value.
- Secure-property symbols omit line spans so source rehydration cannot return the containing value.
- Sensitive file nodes carry `meta.sensitive=true` and a path-derived identity; their body text is not
  added to FTS or semantic inputs.
- The central source/snippet/evidence rehydration path denies sensitive files. For ordinary
  value-redacted property files, MCP `source` returns a generated key-only view with every value
  replaced by `<redacted>`. This prevents a bypass through source, dossier generation, verification,
  or future enrichment while keeping configuration-key discovery useful.
- XML attributes are allowlisted. Values for names containing `password`, `secret`, `token`,
  `credential`, `privateKey`, or equivalent normalized forms are replaced by a redaction marker
  before any node or diagnostic is constructed.
- Property placeholders such as `${db.password}` and `secure::db.password` retain the key reference,
  not the resolved value.

Diagnostics never include raw source fragments from sensitive files.

## 10. Error Handling and Diagnostics

`ExtractResult` gains an optional diagnostics array:

```ts
interface ExtractDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  file?: string;
  span?: Span;
  message: string;
  projectId?: string;
}
```

Diagnostics are deterministic, bounded, value-redacted records. `ParseStats` aggregates counts by
extractor, code, and severity; full diagnostic records are returned in the index report with a
configurable hard cap and truncation count.

Failure policy:

- Unsafe or unsupported archive: fail before indexing and preserve any prior cache/index.
- Ambiguous project dialect: retain file nodes, emit an error, skip semantic parsing for ambiguous
  files.
- Malformed XML/RAML: emit an error and any structurally complete facts parsed before failure.
- Malformed DW/MEL: retain the enclosing processor/expression as a statement, emit a warning, and
  avoid guessed imports/calls.
- Missing static target: create an external placeholder and warning.
- Dynamic target: retain the expression and informational diagnostic; no edge guess.
- Unsupported connector operation: emit the generic processor statement with namespace and local
  operation, so no application step disappears.

An extractor must not throw for a single malformed source file. Programmer errors and violated graph
invariants still fail tests and do not get silently converted into parse diagnostics.

## 11. CLI and Reporting

Existing commands accept directories or archive paths:

```text
crib index ./mule-project
crib index ./mule-project.zip
crib index ./mule-app.jar
crib status ./mule-project.zip
crib reindex ./mule-project.zip
crib update ./mule-project.zip
```

Index output adds a compact Mule summary:

```text
mule: 1 project (v4), 25 flows/subflows, 8 routes, 39 flow refs,
      30 transforms, 6 tests, 3 external targets, 0 errors, 4 warnings
```

`crib status` reports input kind, archive fingerprint state, detected Mule projects/dialects, and
diagnostic counts. `crib gaps` surfaces unresolved/dynamic Mule references using the same gap model
as other languages.

The archive source cache is local and derived. It is not committed. `--crib-dir` retains its current
meaning: the supplied absolute path is the exact crib directory. For an archive input, its persistent
expanded source and input metadata live at `<cribDir>/source-cache` and `<cribDir>/input.json`.
Without `--crib-dir`, the default import workspace keeps separate `source/` and `crib/` directories
under `~/.crib/imports/<path-hash>/`.

## 12. Performance and Determinism

- ZIP/JAR entries stream to disk; archives are never loaded wholly into memory.
- XML uses streaming parse with bounded retained text.
- DataWeave/MEL tokenizers are linear over source and cap expression capture with the existing
  `EXPR_MAX_CHARS` rule.
- RAML include traversal is project-root confined and cycle-detected.
- Project detection scans descriptors first and does not parse every XML file twice.
- The resolver parses each supported file at most once per run and reuses extracted metadata.
- Results persist in discovery order, preserving current serial/concurrent determinism.
- All IDs derive from project-relative paths, qualified names, spans, and stable ordinals; temporary
  extraction paths and machine-specific cache paths never enter IDs or hashes.

## 13. Implementation Stages

The implementation may land internally in stages, but the feature is considered complete only after
both Mule dialects pass their release gates.

1. **Input and classification foundation**
   - archive preparation, persistent source authority, registry/runtime separation;
   - project/dialect/file-role detection and Mule-local ignores;
   - diagnostics and sensitive-source guardrails.
2. **Mule 4 extraction**
   - Mule 4 XML, DW2, APIKit/RAML, properties, descriptors, resolver;
   - sample-project acceptance and archive parity.
3. **Mule 3 extraction**
   - Mule 3 XML/transports, exception strategies, MEL/DW1, descriptors, resolver.
4. **MUnit and hardening**
   - Mule 3/4 tests/mocks/assertions/fixtures;
   - fuzzing, archive adversarial tests, performance, CLI/MCP coverage, packaging notices.

Each stage must keep existing Java/Node and all parser parity tests green.

## 14. Testing Strategy

### 14.1 Unit and golden tests

- Mule 3 and Mule 4 project/dialect detection, including conflicting signals.
- XML namespace handling, CDATA, nested scopes, imports, dynamic/static references, and malformed
  recovery.
- Golden node/edge fixtures for flows, configs, routers, transforms, listeners, requests, errors,
  external placeholders, and property references.
- DW1/DW2/MEL declaration/import/call/reference fixtures.
- RAML resources, nested resources, libraries, traits, types, includes, cycles, and APIKit mapping.
- MUnit tested-flow, mock, assertion, expected-error, and fixture extraction.
- ID and hash stability across repeated runs.
- Capability-honesty and diagnostics tests.

### 14.2 Archive security tests

- ZIP slip, absolute paths, Windows roots, NUL paths, symlinks, duplicate/case-colliding entries.
- Entry-count, expanded-size, per-entry-size, compression-ratio, and encrypted-entry limits.
- Atomic replacement and previous-cache preservation on failure.
- Nested single project, multiple projects, deployable JAR, and attached-source JAR detection.
- Archive fingerprint no-op and changed-archive full reindex.

### 14.3 Secret-regression tests

Canary secret values appear in secure and ordinary fixture files. Tests assert that canaries never
appear in:

- graph JSONL;
- SQLite FTS/search output;
- diagnostics or logs;
- snippets, dossiers, evidence verification, or MCP source responses;
- external source-cache metadata.

Property key names and reference edges must still be present.

### 14.4 Pipeline and compatibility tests

- Default extractor/resolver registration.
- Full and incremental directory indexing.
- Serial, bounded-concurrency, and worker parity.
- Existing Java, TypeScript/Node, Python, PL/SQL, C#, Go, Rust, PHP, and Markdown golden suites.
- CLI index/status/reindex/update behavior for directories and archives.
- External `--crib-dir` and registry overlay behavior.
- Package/install smoke tests including new runtime dependencies and notices.

### 14.5 Sample acceptance

The user-provided `sapi-billing` Mule 4 ZIP remains a local, uncommitted acceptance input. A
synthetic, license-safe fixture reproduces its relevant topology in the repository.

The local acceptance run must find at least:

- 18 flows and 7 subflows;
- 39 flow-reference call sites;
- 10 choice routers;
- 27 transform components and 30 inline DW2 blocks;
- 2 HTTP listeners, 8 business API operations, and 4 outbound HTTP requests;
- 15 error handlers;
- 1 production and 21 test `.dwl` files;
- 6 MUnit tests and 6 mocks;
- the three external flow targets observed in the sample;
- zero indexed secret values and zero generated-report JavaScript symbols.

Exact emitted graph counts become a checked local acceptance snapshot after the implementation fixes
the final generic-processor mapping.

## 15. Acceptance Criteria

The feature is complete when:

1. A directory, ZIP, or Mule JAR can be indexed through the normal CLI.
2. Mule 3 and Mule 4 projects are detected and reported accurately.
3. Static flow/config/module/API/test relationships are traversable through context, path, and impact.
4. Dynamic references remain honest unresolved expressions, not inferred edges.
5. Unknown connectors remain visible as generic processor statements.
6. RAML/APIKit routes, DataWeave/MEL structure, error handling, and MUnit evidence are queryable.
7. Unresolved external targets are preserved as explicit placeholders.
8. No property value, credential, key material, or sensitive file body enters graph/search/output.
9. Archive-backed line evidence remains available after the indexing process exits.
10. Archive attacks fail safely without corrupting a previous index.
11. Repeated runs and parallel modes produce byte-identical extracted graphs.
12. Existing language extractors and CLI behavior remain regression-free.

## 16. Documentation References

- Mule 4 application structure and packaging:
  <https://docs.mulesoft.com/mule-runtime/latest/package-a-mule-application>
- Mule flow and subflow behavior:
  <https://docs.mulesoft.com/mule-runtime/latest/flow-component>
- Flow references:
  <https://docs.mulesoft.com/mule-runtime/latest/flowref-about>
- Mule configuration files and imports:
  <https://docs.mulesoft.com/mule-runtime/latest/about-mule-configuration>
- DataWeave scripts and `.dwl` resources:
  <https://docs.mulesoft.com/dataweave/latest/dataweave-language-introduction>
- Mule property configuration:
  <https://docs.mulesoft.com/mule-runtime/latest/configuring-properties>
