# MuleSoft 4 Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Mule 4 application flows, processor behavior, DataWeave 2, RAML/APIKit, descriptors, configurations, and cross-file references into the existing Knowledge-crib graph.

**Architecture:** A namespace-aware XML reader creates a bounded Mule AST, and focused parsers handle DataWeave, RAML, and descriptors. `MuleExtractor` emits only intra-file facts; `MuleResolver` resolves imports, flow references, configuration references, APIKit operations, and static resources across the complete graph.

**Tech Stack:** TypeScript, Vitest, `saxes`, `yaml`, Knowledge-crib extractor/resolver contracts

---

## File map

- `packages/parsers/src/mule/xml.ts`: secure XML event reader with spans and namespaces.
- `packages/parsers/src/mule/ast.ts`: shared Mule document model.
- `packages/parsers/src/mule/mule4.ts`: Mule 4 element semantics.
- `packages/parsers/src/mule/dataweave.ts`: DW2 declarations, imports, calls, and references.
- `packages/parsers/src/mule/raml.ts`: RAML resource/method/include structure.
- `packages/parsers/src/mule/descriptors.ts`: POM, descriptor, dependency, and key-only properties.
- `packages/parsers/src/mule/MuleExtractor.ts`: classification dispatch and graph emission.
- `packages/pipeline/src/resolve/mule-resolver.ts`: cross-file Mule resolution.
- `packages/pipeline/src/extractors.ts`: built-in extractor registration.
- `packages/pipeline/src/resolve/index.ts`: built-in resolver registration.

## GitNexus execution preconditions

Before editing an existing symbol, call `gitnexus_impact({ target: "<symbol>", direction: "upstream" })` and report its blast radius. The current index rates `defaultExtractors` CRITICAL and `defaultResolvers` HIGH; warn the user before Task 8 edits and re-run both impact calls immediately before changing those functions.

### Task 1: Add secure, span-aware XML parsing

**Files:**
- Modify: `packages/parsers/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/parsers/src/mule/ast.ts`
- Create: `packages/parsers/src/mule/xml.ts`
- Test: `packages/parsers/src/mule/xml.test.ts`

- [ ] **Step 1: Add `saxes`**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers add saxes@^6.0.0`

Expected: parser manifest and lockfile change.

- [ ] **Step 2: Write XML tests for namespaces, CDATA, spans, and DTD rejection**

```ts
it('preserves namespace identity, attributes, CDATA, and line spans', () => {
  const doc = parseMuleXml('<mule xmlns:http="urn:http">\n<flow name="orders">\n<http:request path="/x"><![CDATA[#[payload.id]]]></http:request>\n</flow>\n</mule>');
  expect(doc.root.children[0]).toMatchObject({ local: 'flow', startLine: 2, endLine: 4 });
  expect(doc.root.children[0]?.children[0]).toMatchObject({ uri: 'urn:http', local: 'request', text: '#[payload.id]' });
});

it('rejects document types and entities', () => {
  expect(() => parseMuleXml('<!DOCTYPE mule [<!ENTITY x SYSTEM "file:///etc/passwd">]><mule>&x;</mule>'))
    .toThrow(/DTD|entity/i);
});
```

- [ ] **Step 3: Run the focused XML test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/xml.test.ts`

Expected: FAIL because the parser is absent.

- [ ] **Step 4: Define the bounded XML AST**

```ts
import type { Span } from '@knowledge-crib/soul-schema';

export interface MuleXmlAttribute { uri: string; local: string; value: string }
export interface MuleXmlElement {
  uri: string;
  local: string;
  prefix: string;
  attributes: MuleXmlAttribute[];
  children: MuleXmlElement[];
  text: string;
  startLine: number;
  endLine: number;
}
export interface MuleXmlDocument { root: MuleXmlElement; diagnostics: ExtractDiagnostic[] }
export interface MuleImport { resource: string; span: Span }
export interface MuleConfiguration { namespace: string; name: string; attributes: Record<string, string>; span: Span }
export interface MuleErrorHandler { strategy: string; errorType?: string; processors: MuleProcessor[]; span: Span }
```

Implement `parseMuleXml(source)` with `new SaxesParser({ xmlns: true, position: true })`; reject `ondoctype`, cap depth at 256 and elements at 100,000, append text/CDATA to the active element, and convert parser failures into a thrown `MuleXmlError` carrying line and column.

- [ ] **Step 5: Verify XML behavior**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/xml.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit XML parsing**

```bash
git add packages/parsers/package.json packages/parsers/src/mule/ast.ts packages/parsers/src/mule/xml.ts packages/parsers/src/mule/xml.test.ts pnpm-lock.yaml
git commit -m "feat(parsers): parse secure Mule XML"
```

### Task 2: Normalize Mule 4 elements into a semantic document

**Files:**
- Create: `packages/parsers/src/mule/mule4.ts`
- Test: `packages/parsers/src/mule/mule4.test.ts`

- [ ] **Step 1: Write a semantic fixture test**

Use a fixture containing an HTTP listener flow, `choice`, `foreach`, `parallel-foreach`, `flow-ref`, `ee:transform`, `http:request`, `raise-error`, and `error-handler`.

```ts
const doc = parseMule4(xml);
expect(doc.flows.map((f) => [f.kind, f.name])).toEqual([['flow', 'api-main'], ['subflow', 'lookup']]);
expect(doc.flows[0]?.processors.map((p) => p.semanticKind)).toEqual([
  'source', 'router', 'flow-ref', 'transform', 'outbound-call', 'raise-error',
]);
expect(doc.flows[0]?.errorHandlers).toHaveLength(1);
```

- [ ] **Step 2: Run the test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/mule4.test.ts`

Expected: FAIL because `parseMule4` does not exist.

- [ ] **Step 3: Define semantic types and normalize the tree**

```ts
export interface MuleExpression { raw: string; language: 'dw2' | 'unknown'; span: Span }
export interface MuleProcessor {
  namespace: string;
  operation: string;
  semanticKind: 'source' | 'operation' | 'router' | 'flow-ref' | 'transform' | 'outbound-call' | 'raise-error';
  name?: string;
  configRef?: string;
  target?: string;
  attributes: Record<string, string>;
  expressions: MuleExpression[];
  children: MuleProcessor[];
  span: Span;
}
export interface MuleFlow { name: string; kind: 'flow' | 'subflow'; processors: MuleProcessor[]; errorHandlers: MuleErrorHandler[]; span: Span }
export interface MuleDocument { dialect: 'mule3' | 'mule4'; imports: MuleImport[]; configurations: MuleConfiguration[]; flows: MuleFlow[]; diagnostics: ExtractDiagnostic[] }
export interface Mule4Document extends Omit<MuleDocument, 'dialect'> { dialect: 'mule4' }
```

Map core `flow`, `sub-flow`, `flow-ref`, `choice`, `scatter-gather`, `foreach`, `parallel-foreach`, `until-successful`, `try`, `raise-error`, `error-handler`, `on-error-*`, `ee:transform`, message sources, and connector operations. Preserve unknown processors as `operation` with namespace/local name instead of dropping them. Build configuration/processor attribute maps through `sanitizeMuleAttributes`: retain a semantic allowlist, replace credential-like literal values with `<redacted>`, and convert `${key}` or `secure::key` values into key references before any node or diagnostic is constructed.

- [ ] **Step 4: Run the semantic tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/mule4.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Mule 4 normalization**

```bash
git add packages/parsers/src/mule/mule4.ts packages/parsers/src/mule/mule4.test.ts
git commit -m "feat(parsers): normalize Mule 4 flows"
```

### Task 3: Parse DataWeave 2 without evaluating it

**Files:**
- Create: `packages/parsers/src/mule/dataweave.ts`
- Test: `packages/parsers/src/mule/dataweave.test.ts`

- [ ] **Step 1: Write tests for declarations, imports, calls, properties, and malformed input**

```ts
const result = parseDataWeave(`%dw 2.0
import upper from dw::core::Strings
var region = p('billing.region')
fun total(xs) = xs reduce ((n, acc = 0) -> acc + n)
---
{ id: payload.id, label: upper(payload.name), total: total(payload.lines) }`);
expect(result.version).toBe('2.0');
expect(result.imports).toEqual([{ name: 'upper', module: 'dw::core::Strings', line: 2 }]);
expect(result.declarations.map((d) => d.name)).toEqual(['region', 'total']);
expect(result.propertyKeys).toEqual(['billing.region']);
expect(result.calls.map((c) => c.name)).toEqual(expect.arrayContaining(['upper', 'total', 'p']));
```

- [ ] **Step 2: Run the test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/dataweave.test.ts`

Expected: FAIL because the parser is absent.

- [ ] **Step 3: Implement a bounded tokenizer and structural scanner**

Define tokens for identifiers, strings, numbers, symbols, comments, and newlines with line/column positions. Scan `%dw`, `import`, `var`, `fun`, `type`, `ns`, call expressions, `p('literal')`, `Mule::p('literal')`, and `readUrl('classpath://literal')`. Cap tokens at 200,000 and expression text with `clampExpr`; emit diagnostics for unterminated strings/comments and dynamic property/resource names.

```ts
export interface DataWeaveResult {
  version?: string;
  declarations: Array<{ kind: 'var' | 'fun' | 'type' | 'ns'; name: string; line: number; expr?: string }>;
  imports: Array<{ name: string; module: string; line: number }>;
  calls: Array<{ name: string; line: number }>;
  references: Array<{ kind: 'variable' | 'property' | 'resource'; name: string; line: number }>;
  propertyKeys: string[];
  resources: string[];
  diagnostics: ExtractDiagnostic[];
}
```

- [ ] **Step 4: Run DataWeave tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/dataweave.test.ts`

Expected: PASS, including malformed-input diagnostics with no throw.

- [ ] **Step 5: Commit DataWeave parsing**

```bash
git add packages/parsers/src/mule/dataweave.ts packages/parsers/src/mule/dataweave.test.ts
git commit -m "feat(parsers): scan DataWeave 2 semantics"
```

### Task 4: Parse descriptors, dependencies, and property keys

**Files:**
- Create: `packages/parsers/src/mule/descriptors.ts`
- Test: `packages/parsers/src/mule/descriptors.test.ts`

- [ ] **Step 1: Write descriptor tests**

```ts
expect(parseProperties('db.user=alice\ndb.password=swordfish')).toEqual({ keys: ['db.password', 'db.user'], diagnostics: [] });
expect(parseMuleArtifact('{"minMuleVersion":"4.4.0","requiredProduct":"MULE_EE"}')).toMatchObject({ minMuleVersion: '4.4.0' });
expect(parsePom(pom).dependencies).toContainEqual({ groupId: 'org.mule.connectors', artifactId: 'mule-http-connector', versionRef: '${http.version}' });
```

- [ ] **Step 2: Run tests and implement key-only outputs**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/descriptors.test.ts`

Expected before implementation: FAIL. Implement `parseProperties`, `parseMuleArtifact`, and `parsePom` so property values never appear in return types or diagnostics. XML POM parsing must use `parseMuleXml`; JSON parsing must report invalid JSON as a diagnostic rather than throw.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/descriptors.test.ts`

Expected: PASS.

```bash
git add packages/parsers/src/mule/descriptors.ts packages/parsers/src/mule/descriptors.test.ts
git commit -m "feat(parsers): extract Mule descriptors safely"
```

### Task 5: Parse RAML and APIKit mappings

**Files:**
- Modify: `packages/parsers/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/parsers/src/mule/raml.ts`
- Test: `packages/parsers/src/mule/raml.test.ts`

- [ ] **Step 1: Add YAML and write RAML tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers add yaml@^2.8.0`

Test nested resources, methods, types, traits, security schemes, and `!include` values. Assert aliases are capped, merge keys disabled, and includes are returned as references rather than read recursively.

```ts
expect(parseRaml(raml)).toMatchObject({
  resources: [{ path: '/orders', methods: [{ method: 'get' }, { method: 'post' }] }],
  includes: ['types/order.raml'],
});
```

- [ ] **Step 2: Implement safe YAML document traversal**

Use `parseDocument(source, { customTags: [{ tag: '!include', resolve: (value) => ({ include: String(value) }) }], maxAliasCount: 50, merge: false })`. Walk keys beginning with `/` as resources and HTTP verb keys as operations. Preserve line positions from YAML nodes and return parse errors as diagnostics.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/raml.test.ts`

Expected: PASS.

```bash
git add packages/parsers/package.json packages/parsers/src/mule/raml.ts packages/parsers/src/mule/raml.test.ts pnpm-lock.yaml
git commit -m "feat(parsers): extract RAML API structure"
```

### Task 6: Emit Mule 4 graph nodes and intra-file edges

**Files:**
- Create: `packages/parsers/src/mule/MuleExtractor.ts`
- Test: `packages/parsers/src/mule/MuleExtractor.test.ts`
- Modify: `packages/parsers/src/index.ts`

- [ ] **Step 1: Write graph-contract tests**

For a classified Mule 4 fixture, assert deterministic node IDs and these mappings:

| Mule fact | Schema representation | Required metadata |
|---|---|---|
| flow | `kind: symbol`, `type: flow` | dialect, projectId |
| subflow | `kind: symbol`, `type: subflow` | dialect, projectId |
| connector/global config | `kind: symbol`, `type: config` | namespace, configuration name |
| property key | `kind: symbol`, `type: property` | key, `valueRedacted: true` |
| POM connector | `kind: symbol`, `type: dependency` | groupId, artifactId, versionRef |
| processor | `statement` | namespace, operation, semanticKind |
| choice route | `condition` | expression, route index |
| DataWeave function/module | `kind: symbol`, `type: function/module` | version, module/import name |
| listener or RAML method | `route` | HTTP method, templated route path |
| outbound HTTP request | `http-call` | HTTP method, templated route path |
| error handler | `exception-handler` | strategy, error type |

Assert `member-of`, `executes`, `guarded-by`, and local `calls` edges; assert no raw property value appears in `JSON.stringify(result)`.

- [ ] **Step 2: Run the extractor test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/MuleExtractor.test.ts`

Expected: FAIL because `MuleExtractor` is absent.

- [ ] **Step 3: Implement classification dispatch and honest fallback**

```ts
export class MuleExtractor implements Extractor {
  readonly name = 'family:mulesoft';
  readonly capabilities = { imports: true, calls: true, inheritance: false, types: 'none' } as const;

  supports(file: FileMeta): boolean { return file.classification?.family === 'mule'; }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    const c = file.classification;
    if (!c) return { nodes: [], edges: [] };
    try {
      const source = await ctx.readText();
      return extractClassifiedMuleFile(file, c, source, ctx);
    } catch (error) {
      return { nodes: [], edges: [], diagnostics: [{ code: 'mule:parse-failed', severity: 'error', message: error instanceof Error ? error.message : String(error), file: file.path, projectId: c.projectId }] };
    }
  }
}
```

Route configuration XML, DW, RAML, descriptors, and properties to focused parsers. During this phase a file classified with role `munit` remains represented by its structure-phase file node; MUnit semantic nodes are introduced by the hardening plan. Keep all cross-file names as metadata/reference nodes for the resolver; do not resolve against files not present in `ExtractCtx`.

- [ ] **Step 4: Export and verify**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/mule/MuleExtractor.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/parsers typecheck`

Expected: PASS.

- [ ] **Step 5: Commit graph emission**

```bash
git add packages/parsers/src/mule/MuleExtractor.ts packages/parsers/src/mule/MuleExtractor.test.ts packages/parsers/src/index.ts
git commit -m "feat(parsers): emit Mule 4 graph semantics"
```

### Task 7: Resolve Mule references across files

**Files:**
- Create: `packages/pipeline/src/resolve/mule-resolver.ts`
- Test: `packages/pipeline/src/resolve/mule-resolver.test.ts`

- [ ] **Step 1: Write resolver tests**

Cover local imported configurations, `flow-ref`, connector `config-ref`, DW module/resource references, RAML includes, and APIKit `resource:method` mappings. Assert dynamic names produce diagnostics/unresolved metadata and static missing flow targets produce external placeholder nodes.

```ts
expect(edges).toContainEqual(expect.objectContaining({ rel: 'calls', src: enclosingFlowId, dst: targetFlowId, evidence: expect.objectContaining({ callSite: flowRefId }) }));
expect(nodes).toContainEqual(expect.objectContaining({ kind: 'symbol', type: 'external-flow', name: 'missingFlow', meta: expect.objectContaining({ family: 'mule' }) }));
```

- [ ] **Step 2: Implement a project-scoped symbol table**

Index nodes by `projectId + type + name`; resolve only within the same detected Mule project unless an explicit domain/import reference names another project. Emit only schema-valid `calls`, `imports`, and `references` relations. A static flow reference creates `calls` from its enclosing flow symbol to the target flow, with the processor ID retained in evidence. Configuration references use `rel: 'references'` plus `evidence.referenceKind: 'config'`; use `edgeId` and EXTRACTED provenance matching existing resolvers.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/resolve/mule-resolver.test.ts`

Expected: PASS.

```bash
git add packages/pipeline/src/resolve/mule-resolver.ts packages/pipeline/src/resolve/mule-resolver.test.ts
git commit -m "feat(pipeline): resolve Mule references"
```

### Task 8: Register the built-in extractor and resolver

**Files:**
- Modify: `packages/pipeline/src/extractors.ts`
- Modify: `packages/pipeline/src/resolve/index.ts`
- Test: `packages/pipeline/src/parse-concurrent.test.ts`
- Test: `packages/pipeline/src/resolve/resolve.test.ts`
- Test: `packages/parsers/src/parity-coverage.test.ts`

- [ ] **Step 1: Add fleet parity tests before registration**

Assert `defaultExtractors()` contains exactly one `family:mulesoft`, `defaultResolvers()` contains exactly one Mule resolver, worker and serial parsing produce identical output for the Mule fixture, and the capability-honesty test expects no inheritance/type edges.

- [ ] **Step 2: Run parity tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/parse-concurrent.test.ts src/resolve/resolve.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/parity-coverage.test.ts`

Expected: FAIL because Mule is not in the default fleet.

- [ ] **Step 3: Register Mule last in each fleet**

```ts
// defaultExtractors
new PhpExtractor(),
new MuleExtractor(),

// defaultResolvers
new RustResolver(),
new MuleResolver(),
```

Classification makes supports-dispatch disjoint from generic XML/resource files, so registration order cannot steal JavaScript report files or ordinary XML documents.

- [ ] **Step 4: Run package verification**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test && corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test && corepack pnpm@9.15.0 -r typecheck`

Expected: PASS.

- [ ] **Step 5: Run GitNexus change detection and commit**

Call: `gitnexus_detect_changes()`

Expected: default extraction and resolution flows gain one disjoint Mule branch; existing language flows remain unchanged.

```bash
git add packages/pipeline/src/extractors.ts packages/pipeline/src/resolve/index.ts packages/pipeline/src/parse-concurrent.test.ts packages/pipeline/src/resolve/resolve.test.ts packages/parsers/src/parity-coverage.test.ts
git commit -m "feat: ship Mule 4 extraction by default"
```
