# MuleSoft MUnit and Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Mule 3/4 MUnit migration evidence, adversarial parser coverage, sample-project acceptance checks, user documentation, and release/license verification.

**Architecture:** MUnit is parsed into the same application graph with test nodes pointing at tested flows, mocks, fixtures, assertions, and expected errors. Fuzzing and archive attack suites harden all new untrusted-input boundaries. A local-only acceptance command verifies the supplied `sapi-billing` archive without committing proprietary content.

**Tech Stack:** TypeScript, Vitest, fast-check, existing extractor fuzz workers, CLI smoke tests

---

## File map

- `packages/parsers/src/mule/munit.ts`: MUnit 3/4 semantic normalization.
- `packages/parsers/src/mule/MuleExtractor.ts`: MUnit graph emission.
- `packages/pipeline/src/resolve/mule-resolver.ts`: tested-flow, mock, and fixture resolution.
- `packages/parsers/src/fuzz/fuzz-extractors.ts`: Mule extractor fuzz registration.
- `packages/pipeline/src/input/archive.test.ts`: full archive attack matrix.
- `scripts/check-mule-sample.mjs`: local-only acceptance count checker.
- `docs/mulesoft.md`: supported inputs, semantics, diagnostics, and limitations.
- `packages/cli/src/cli.ts`: concise Mule coverage summary.

## GitNexus execution preconditions

Before changing any existing extractor, resolver, CLI, fuzz-worker, or archive symbol, call `gitnexus_impact({ target: "<symbol>", direction: "upstream" })`, report the blast radius, and warn before HIGH or CRITICAL edits. Call `gitnexus_detect_changes()` before each commit.

### Task 1: Normalize Mule 4 MUnit tests

**Files:**
- Create: `packages/parsers/src/mule/munit.ts`
- Test: `packages/parsers/src/mule/munit.test.ts`

- [ ] **Step 1: Write a Mule 4 MUnit fixture test**

Cover `munit:test`, behavior/execution/validation blocks, `flow-ref`, `mock-when`, `then-return`, `spy`, `verify-call`, `assert-that`, `assert-equals`, `set-event`, `enable-flow-sources`, and expected error type.

```ts
const suite = parseMUnit(xml, 'mule4');
expect(suite.tests[0]).toMatchObject({
  name: 'billing-api-test', testedFlows: ['billing-api'], expectedErrorType: 'BILLING:NOT_FOUND',
});
expect(suite.tests[0]?.mocks).toContainEqual(expect.objectContaining({ processor: 'http:request' }));
expect(suite.tests[0]?.assertions.map((a) => a.kind)).toEqual(expect.arrayContaining(['assert-that', 'verify-call']));
```

- [ ] **Step 2: Run the focused test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/munit.test.ts`

Expected: FAIL because `parseMUnit` is absent.

- [ ] **Step 3: Implement dialect-aware MUnit normalization**

```ts
export interface MUnitTest {
  name: string;
  description?: string;
  testedFlows: string[];
  expectedErrorType?: string;
  mocks: Array<{ processor: string; configRef?: string; attributes: Record<string, string>; fixture?: string; span: Span }>;
  assertions: Array<{ kind: string; expression?: string; expected?: string; span: Span }>;
  fixtures: string[];
  span: Span;
}
export interface MUnitSuite { dialect: 'mule3' | 'mule4'; tests: MUnitTest[]; diagnostics: ExtractDiagnostic[] }
```

Normalize only static processor names, flow names, config refs, fixture paths, expected error types, and capped assertion expressions. Never retain literal credential-like values from mock payloads or variables; store the expression kind and a redaction marker when a name matches the existing secret classifier.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/munit.test.ts`

Expected: PASS.

```bash
git add packages/parsers/src/mule/munit.ts packages/parsers/src/mule/munit.test.ts
git commit -m "feat(parsers): normalize Mule 4 MUnit"
```

### Task 2: Add Mule 3 MUnit compatibility

**Files:**
- Modify: `packages/parsers/src/mule/munit.ts`
- Modify: `packages/parsers/src/mule/munit.test.ts`

- [ ] **Step 1: Add Mule 3 MUnit cases**

Cover legacy namespaces and `munit:test`, `mock:when`, `mock:then-return`, `munit:assert-*`, flow invocation, inbound/outbound property setup, and expected exception assertions.

- [ ] **Step 2: Add a dialect mapping table**

```ts
const MUNIT_NAMES = {
  mule4: { mock: new Set(['mock-when']), verify: new Set(['verify-call']) },
  mule3: { mock: new Set(['when', 'mock-when']), verify: new Set(['verify-call', 'verify-times-called']) },
} as const;
```

Keep one output type and attach dialect metadata; do not duplicate graph emission logic.

- [ ] **Step 3: Verify both dialects and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/munit.test.ts`

Expected: PASS for Mule 3 and Mule 4.

```bash
git add packages/parsers/src/mule/munit.ts packages/parsers/src/mule/munit.test.ts
git commit -m "feat(parsers): normalize Mule 3 MUnit"
```

### Task 3: Emit and resolve MUnit migration evidence

**Files:**
- Modify: `packages/parsers/src/mule/MuleExtractor.ts`
- Modify: `packages/parsers/src/mule/MuleExtractor.test.ts`
- Modify: `packages/pipeline/src/resolve/mule-resolver.ts`
- Modify: `packages/pipeline/src/resolve/mule-resolver.test.ts`

- [ ] **Step 1: Write graph tests**

Assert each MUnit case emits `kind: 'symbol', type: 'test'` nodes; mocks and assertions emit child statement nodes; test-to-flow edges use the schema-valid `calls` relation, while mock-target and fixture edges use `references` with a specific `evidence.referenceKind`; and expected error types remain metadata. Assert missing fixtures/flows become `kind: 'symbol'` external placeholders.

```ts
expect(nodes).toContainEqual(expect.objectContaining({ kind: 'symbol', type: 'test', name: 'billing-api-test', meta: expect.objectContaining({ dialect: 'mule4' }) }));
expect(edges).toContainEqual(expect.objectContaining({ rel: 'calls', src: testId, dst: flowId, evidence: expect.objectContaining({ referenceKind: 'test-target' }) }));
```

- [ ] **Step 2: Add MUnit graph emission**

Use deterministic IDs from project ID, file path, test name, child kind, and start line. Emit only intra-file `member-of`/`executes` edges in the extractor; add tested-flow, fixture, and mock-target edges in `MuleResolver`.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/MuleExtractor.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/resolve/mule-resolver.test.ts`

Expected: PASS.

```bash
git add packages/parsers/src/mule/MuleExtractor.ts packages/parsers/src/mule/MuleExtractor.test.ts packages/pipeline/src/resolve/mule-resolver.ts packages/pipeline/src/resolve/mule-resolver.test.ts
git commit -m "feat: link MUnit migration evidence"
```

### Task 4: Add the Mule extractor to deterministic fuzzing

**Files:**
- Modify: `packages/parsers/src/fuzz/fuzz-extractors.ts`
- Modify: `packages/parsers/src/fuzz/extractor-fuzz.test.ts`
- Modify: `packages/parsers/src/fuzz/fuzz-worker.ts`

- [ ] **Step 1: Add Mule to the fleet test**

```ts
expect(FUZZ_EXTRACTORS.map((s) => s.name)).toContain('MuleExtractor');
```

Add seeded inputs emphasizing `<`, `>`, namespaces, CDATA, expressions, quotes, deep nesting, invalid UTF-8 replacement characters, and large attribute counts.

- [ ] **Step 2: Register a classified fuzz file**

Extend `FuzzExtractorSpec` with optional `classification`; register:

```ts
{
  name: MuleExtractor.name,
  ctor: MuleExtractor,
  ext: '.xml',
  classification: { family: 'mule', projectId: '.', projectRoot: '', dialect: 'mule4', role: 'config' },
}
```

The fuzz worker must copy that classification into `FileMeta`; otherwise `supports()` correctly refuses the input and the test would fuzz nothing.

- [ ] **Step 3: Run deterministic fuzz gates**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/fuzz/extractor-fuzz.test.ts && corepack pnpm@9.15.0 fuzz:check`

Expected: PASS with zero crashes, hangs, invalid nodes, invalid edges, or nondeterministic outputs.

- [ ] **Step 4: Commit fuzz coverage**

```bash
git add packages/parsers/src/fuzz/fuzz-extractors.ts packages/parsers/src/fuzz/extractor-fuzz.test.ts packages/parsers/src/fuzz/fuzz-worker.ts
git commit -m "test(parsers): fuzz Mule extraction"
```

### Task 5: Complete the archive attack matrix

**Files:**
- Modify: `packages/pipeline/src/input/archive.test.ts`

- [ ] **Step 1: Add adversarial cases**

Generate and assert rejection for NUL, backslash traversal, symlink Unix mode, hardlink mode, duplicate normalized paths, case-fold collisions, encrypted flags, unsupported compression, 50,001 entries, 100 MiB plus one byte entry, 2 GiB plus one byte total declarations, and compression ratio over 100:1. Tests may patch central-directory metadata rather than allocate the declared expanded sizes.

Also add valid cases for a nested single project, two projects in one ZIP, a deployable JAR with root configuration, and a JAR containing both packaged XML and `META-INF/mule-src`. Assert attached source wins, packaged duplicates are skipped deterministically, and the skipped paths appear only in bounded diagnostics.

- [ ] **Step 2: Assert atomic failure semantics**

Prepare a valid cache, attempt refresh with each invalid archive, then assert the previous source file and `input.json` fingerprint remain unchanged and no staging directory remains.

- [ ] **Step 3: Run archive tests and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/input/archive.test.ts`

Expected: PASS.

```bash
git add packages/pipeline/src/input/archive.test.ts
git commit -m "test(pipeline): harden archive extraction"
```

### Task 6: Add local sample-project acceptance checking

**Files:**
- Create: `scripts/check-mule-sample.mjs`
- Create: `scripts/fixtures/synthetic-mule-project.mjs`
- Modify: `package.json`
- Create: `scripts/check-mule-sample.test.mjs`

- [ ] **Step 1: Write the checker contract test with a synthetic manifest**

The test creates a license-safe temporary project with `syntheticMuleProject(root)`, invokes the real CLI/checker, verifies every topology count, and verifies failures print the differing metric, expected count, and actual count.

- [ ] **Step 2: Implement an explicit-path local checker**

```js
const expected = {
  flows: 18, subflows: 7, flowRefs: 39, choices: 10, transforms: 27,
  inlineDw2: 30, listeners: 2, apiOperations: 8, outboundCalls: 4,
  errorHandlers: 15, productionDwl: 1, testDwl: 21, munitTests: 6,
  mocks: 6, externalFlowTargets: 3,
};
```

Require `--archive <absolute-path>` and reject missing/non-file inputs. Run the built CLI into a temporary registry/cache, read graph JSONL through public soul APIs, calculate counts, assert zero raw property values and zero symbols from `reports/assets/js/tsorter.min.js`, print a table, and exit nonzero on a mismatch. Never copy or stage the archive.

Implement `syntheticMuleProject(root)` as a deterministic fixture generator: create 18 flows, 7 subflows, 39 flow refs (three unique unresolved targets), 10 choices, 27 transforms, 30 inline DW2 blocks, 2 listeners, 8 APIKit operations, 4 outbound HTTP requests, 15 error handlers, one production `.dwl`, 21 test `.dwl` files, and 6 MUnit tests with one mock each. Include ordinary and secure property canaries plus generated report JavaScript so the same fixture verifies extraction altitude and redaction.

Add root script: `"check:mule-sample": "node scripts/check-mule-sample.mjs"`.

- [ ] **Step 3: Verify against the supplied sample locally**

Run: `corepack pnpm@9.15.0 build && corepack pnpm@9.15.0 check:mule-sample -- --archive '/Users/vishalchawla/Downloads/sapi-billing (2).zip'`

Expected: all approved acceptance counts PASS, secrets found = 0, report-JS symbols = 0.

- [ ] **Step 4: Commit only the checker**

```bash
git add scripts/check-mule-sample.mjs scripts/check-mule-sample.test.mjs package.json
git commit -m "test: add local Mule sample acceptance gate"
```

### Task 7: Document support and expose concise diagnostics

**Files:**
- Create: `docs/mulesoft.md`
- Modify: `README.md`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/cli.test.ts`

- [ ] **Step 1: Write CLI output tests**

Assert index output includes project count, Mule 3/4 file counts, flows, subflows, MUnit tests, resolved/unresolved references, warnings, and errors. Assert `--json` includes the same values under `mulesoft` without changing existing top-level fields.

- [ ] **Step 2: Add a stable summary type and renderer**

```ts
interface MuleIndexSummary {
  projects: number;
  dialectFiles: { mule3: number; mule4: number };
  flows: number;
  subflows: number;
  routes: number;
  flowRefs: number;
  transforms: number;
  munitTests: number;
  externalTargets: number;
  references: { resolved: number; unresolved: number };
  diagnostics: { warnings: number; errors: number };
}
```

Derive counts from classified files, emitted nodes/edges, and parse diagnostics. Do not make index success depend on warning count; error diagnostics for individual files are reported while the rest of the project remains queryable.

- [ ] **Step 3: Write user documentation**

Document directory/ZIP/JAR examples, archive cache location, `--crib-dir`, Mule 3/4 detection, supported constructs, property key-only behavior, denied secure resources, MUnit semantics, unresolved placeholders, archive-update behavior, unsupported watch/Git ownership for archives, and the non-goal of Java generation.

- [ ] **Step 4: Verify docs and CLI tests, then commit**

Run: `corepack pnpm@9.15.0 --filter knowledge-crib test -- src/cli.test.ts && corepack pnpm@9.15.0 --filter knowledge-crib typecheck`

Expected: PASS.

```bash
git add docs/mulesoft.md README.md packages/cli/src/cli.ts packages/cli/src/cli.test.ts
git commit -m "docs: document MuleSoft extraction"
```

### Task 8: Run release gates

- [ ] **Step 1: Run all tests, typechecks, and builds**

Run: `corepack pnpm@9.15.0 test && corepack pnpm@9.15.0 -r typecheck && corepack pnpm@9.15.0 -r build`

Expected: PASS.

- [ ] **Step 2: Verify deterministic serial/parallel sample output**

Index the synthetic Mule fixture with `KCRIB_PARALLEL=0` and `KCRIB_PARALLEL=1`; normalize only timestamps and assert graph JSONL, diagnostics, and summary counts are byte-identical.

- [ ] **Step 3: Verify package contents and notices**

Pack parser, pipeline, core, MCP, and CLI packages; assert required `dist` modules are present, test fixtures are absent from published packages unless explicitly needed, and NOTICE/license inventory includes `saxes`, `yaml`, `yauzl`, and transitive licenses.

- [ ] **Step 4: Run GitNexus scope verification**

Call: `gitnexus_detect_changes()`

Expected: only approved Mule input, parser, resolver, source-policy, CLI-summary, fuzz, and documentation execution flows are affected.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check && git status --short && git log --oneline --decorate -20`

Expected: no whitespace errors; the proprietary sample is untracked nowhere and absent from history.
