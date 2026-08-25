# MuleSoft 3 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shared Mule extractor to represent Mule 3 flows, transports, exception strategies, MEL, DataWeave 1, and legacy MUnit-era layouts without weakening Mule 4 behavior.

**Architecture:** Mule 3 receives a dedicated semantic normalizer and expression scanners, but emits the same graph vocabulary as Mule 4. The existing `MuleExtractor` dispatches on `FileClassification.dialect`, and the shared resolver consumes dialect-neutral reference metadata.

**Tech Stack:** TypeScript, Vitest, existing secure XML AST and Mule graph contracts

---

## File map

- `packages/parsers/src/mule/mule3.ts`: legacy transports, endpoints, flow constructs, and exception strategies.
- `packages/parsers/src/mule/mel.ts`: bounded MEL call/property/resource scanner.
- `packages/parsers/src/mule/dataweave.ts`: DataWeave 1 header and syntax support.
- `packages/parsers/src/mule/MuleExtractor.ts`: dialect dispatch.
- `packages/pipeline/src/mule/classify.ts`: stronger legacy descriptor/layout signals.
- `packages/pipeline/src/resolve/mule-resolver.ts`: dialect-neutral legacy reference resolution.

## GitNexus execution preconditions

Before editing any symbol created by the earlier plans or any existing classification/resolver symbol, call `gitnexus_impact({ target: "<symbol>", direction: "upstream" })`. Report and warn on HIGH or CRITICAL results before editing; then call `gitnexus_detect_changes()` before each commit.

### Task 1: Lock Mule 3 detection with fixtures

**Files:**
- Create: `packages/parsers/src/mule/__fixtures__/mule3/legacy-flow.xml`
- Create: `packages/parsers/src/mule/__fixtures__/mule3/mule-project.xml`
- Modify: `packages/pipeline/src/mule/classify.test.ts`
- Modify: `packages/pipeline/src/mule/classify.ts`

- [ ] **Step 1: Add fixture-driven detection tests**

Assert these strong legacy signals: `.mule` project descriptor, `mule-project.xml`, `src/main/app`, Mule 3 transport namespaces, `inbound-endpoint`, and `catch-exception-strategy`. Assert a Mule 3 root beside a Mule 4 root remains independently classified.

- [ ] **Step 2: Run classification tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/mule/classify.test.ts`

Expected: at least one legacy fixture FAILS classification before the new signals are added.

- [ ] **Step 3: Add explicit legacy signals**

```ts
const MULE3_XML_SIGNALS = [
  /schema\/mule\/(vm|jms|http|https|file|ftp|sftp)\/current/,
  /<(?:\w+:)?(?:inbound-endpoint|outbound-endpoint|catch-exception-strategy|choice-exception-strategy)\b/,
] as const;
```

Score a legacy descriptor or `src/main/app` as 3 and namespace/element evidence as 2. Do not change the ambiguity rule established in the foundation plan.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/mule/classify.test.ts`

Expected: PASS.

```bash
git add packages/parsers/src/mule/__fixtures__/mule3 packages/pipeline/src/mule/classify.ts packages/pipeline/src/mule/classify.test.ts
git commit -m "feat(pipeline): detect Mule 3 projects"
```

### Task 2: Normalize Mule 3 transports and exception strategies

**Files:**
- Create: `packages/parsers/src/mule/mule3.ts`
- Test: `packages/parsers/src/mule/mule3.test.ts`

- [ ] **Step 1: Write semantic tests**

Use the fixture to assert inbound endpoints become `source`, outbound endpoints become `outbound-call`, `async` and `choice` retain nested routes, `processor-chain` retains order, and catch/rollback/choice/reference exception strategies become error handlers.

```ts
expect(doc.flows[0]?.processors.map((p) => p.semanticKind)).toEqual([
  'source', 'operation', 'router', 'outbound-call',
]);
expect(doc.flows[0]?.errorHandlers.map((h) => h.strategy)).toEqual(['catch', 'rollback']);
```

- [ ] **Step 2: Run the test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/mule3.test.ts`

Expected: FAIL because `parseMule3` is absent.

- [ ] **Step 3: Implement Mule 3 semantic mapping**

```ts
export interface Mule3Document extends Omit<MuleDocument, 'dialect'> { dialect: 'mule3' }

export function parseMule3(source: string): Mule3Document {
  const xml = parseMuleXml(source);
  return normalizeMule3(xml);
}

function normalizeMule3(xml: MuleXmlDocument): Mule3Document {
  return {
    dialect: 'mule3',
    imports: collectMule3Imports(xml.root),
    configurations: collectMule3Configurations(xml.root),
    flows: collectMule3Flows(xml.root),
    diagnostics: xml.diagnostics,
  };
}
```

Define `collectMule3Imports`, `collectMule3Configurations`, and `collectMule3Flows` in the same file. Map transport namespace + inbound/outbound endpoint direction, connector refs, `component`, `expression-component`, `custom-transformer`, `message-properties-transformer`, `set-payload`, `set-variable`, routers, chains, async scopes, polling, batch, and exception strategies. Preserve unrecognized elements as ordinary operations and emit an informational diagnostic containing namespace/local name.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/mule3.test.ts`

Expected: PASS.

```bash
git add packages/parsers/src/mule/mule3.ts packages/parsers/src/mule/mule3.test.ts
git commit -m "feat(parsers): normalize Mule 3 flows"
```

### Task 3: Scan MEL expressions honestly

**Files:**
- Create: `packages/parsers/src/mule/mel.ts`
- Test: `packages/parsers/src/mule/mel.test.ts`

- [ ] **Step 1: Write MEL tests**

```ts
const result = parseMel(`#[flowVars.customerId != null ? app.registry['region'] : p('fallback.region')]`);
expect(result.references).toEqual(expect.arrayContaining([
  { kind: 'variable', name: 'customerId', line: 1 },
  { kind: 'property', name: 'fallback.region', line: 1 },
]));
expect(result.calls.map((c) => c.name)).toContain('p');
```

Add cases for `message.inboundProperties`, `sessionVars`, `muleContext.registry`, method calls, escaped strings, comments, and dynamic property arguments.

- [ ] **Step 2: Implement a non-evaluating tokenizer/scanner**

```ts
export interface MelResult {
  references: Array<{ kind: 'variable' | 'property' | 'registry' | 'resource'; name: string; line: number }>;
  calls: Array<{ name: string; line: number }>;
  diagnostics: ExtractDiagnostic[];
}
```

Tokenize identifiers, member access, bracket string access, calls, and literals. Never evaluate arithmetic, ternaries, reflection, Java calls, or collection projections. Static literal names are facts; dynamic arguments produce `mule:dynamic-reference` diagnostics.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/mel.test.ts`

Expected: PASS.

```bash
git add packages/parsers/src/mule/mel.ts packages/parsers/src/mule/mel.test.ts
git commit -m "feat(parsers): scan MEL references"
```

### Task 4: Extend DataWeave scanning to version 1

**Files:**
- Modify: `packages/parsers/src/mule/dataweave.ts`
- Modify: `packages/parsers/src/mule/dataweave.test.ts`

- [ ] **Step 1: Add DW1 syntax tests**

Cover `%dw 1.0`, `%input`, `%output`, `%var`, `%function`, `using`, `when/otherwise`, `mapObject`, and `flowVars`/`inboundProperties` references. Assert the existing DW2 fixture remains byte-identical.

- [ ] **Step 2: Run the tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/dataweave.test.ts`

Expected: FAIL on DW1 declarations while DW2 continues passing.

- [ ] **Step 3: Add version-gated declaration aliases**

```ts
const declarationKeywords = (version: string | undefined) =>
  version?.startsWith('1.')
    ? new Map([['%var', 'var'], ['%function', 'fun']])
    : new Map([['var', 'var'], ['fun', 'fun'], ['type', 'type'], ['ns', 'ns']]);
```

Keep the same `DataWeaveResult` type. Record `flowVars`, `sessionVars`, and property access as references in expression metadata, without adding type or value inference.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/dataweave.test.ts`

Expected: PASS for both versions.

```bash
git add packages/parsers/src/mule/dataweave.ts packages/parsers/src/mule/dataweave.test.ts
git commit -m "feat(parsers): scan DataWeave 1 semantics"
```

### Task 5: Dispatch Mule 3 files through the shared extractor

**Files:**
- Modify: `packages/parsers/src/mule/MuleExtractor.ts`
- Modify: `packages/parsers/src/mule/MuleExtractor.test.ts`
- Modify: `packages/parsers/src/index.ts`

- [ ] **Step 1: Add Mule 3 graph tests**

Assert the legacy fixture emits `kind: 'symbol'` nodes with types `flow`, `subflow`, `config`, `property`, and `dependency` using the same IDs and vocabulary as Mule 4, with `meta.dialect: 'mule3'`. Assert MEL/DW1 expressions are attached to statement/condition nodes and property values are absent.

- [ ] **Step 2: Add dialect dispatch**

```ts
const document = classification.dialect === 'mule3'
  ? parseMule3(source)
  : parseMule4(source);
```

For `.mel` resources call `parseMel`; for inline Mule 3 expression attributes call `parseMel`; for DW1 call the shared DataWeave scanner. Keep descriptor/RAML/property paths shared.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/MuleExtractor.test.ts src/mule/mule3.test.ts src/mule/mel.test.ts src/mule/dataweave.test.ts`

Expected: PASS.

```bash
git add packages/parsers/src/mule/MuleExtractor.ts packages/parsers/src/mule/MuleExtractor.test.ts packages/parsers/src/index.ts
git commit -m "feat(parsers): emit Mule 3 graph semantics"
```

### Task 6: Resolve legacy endpoint, strategy, and flow references

**Files:**
- Modify: `packages/pipeline/src/resolve/mule-resolver.ts`
- Modify: `packages/pipeline/src/resolve/mule-resolver.test.ts`

- [ ] **Step 1: Add legacy resolver cases**

Assert `flow-ref`, `exception-strategy ref`, connector refs, transformer refs, endpoint refs, and imported configuration resources resolve inside the same Mule 3 project. Assert unresolved static targets become external placeholders tagged `dialect: mule3`.

- [ ] **Step 2: Extend the reference-kind table**

```ts
const EDGE_BY_REFERENCE_KIND = {
  flow: 'calls',
  config: 'references',
  import: 'imports',
  resource: 'references',
  exceptionStrategy: 'references',
  endpoint: 'references',
  transformer: 'references',
} as const;
```

No dialect branch is needed after reference emission; only the extractor decides which XML syntax creates each reference kind.

- [ ] **Step 3: Verify all Mule resolver tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/resolve/mule-resolver.test.ts`

Expected: PASS for Mule 3 and Mule 4.

- [ ] **Step 4: Commit legacy resolution**

```bash
git add packages/pipeline/src/resolve/mule-resolver.ts packages/pipeline/src/resolve/mule-resolver.test.ts
git commit -m "feat(pipeline): resolve Mule 3 references"
```

### Task 7: Run dialect parity and package gates

- [ ] **Step 1: Prove Mule 4 output did not regress**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/mule4.test.ts src/mule/MuleExtractor.test.ts`

Expected: Mule 4 snapshots/counts remain unchanged except for explicitly additive shared metadata.

- [ ] **Step 2: Run parser and pipeline suites in serial and parallel modes**

Run: `KCRIB_PARALLEL=0 corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test && KCRIB_PARALLEL=1 corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test && corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test`

Expected: PASS.

- [ ] **Step 3: Run typecheck, build, and GitNexus scope detection**

Run: `corepack pnpm@9.15.0 -r typecheck && corepack pnpm@9.15.0 -r build`

Then call: `gitnexus_detect_changes()`

Expected: PASS; change detection reports additions inside Mule classification/extraction/resolution flows only.
