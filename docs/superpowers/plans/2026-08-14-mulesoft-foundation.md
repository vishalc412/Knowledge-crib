# MuleSoft Foundation and Safe Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make directories, Mule ZIP exports, and Mule JARs safe, persistent, classifiable inputs while adding diagnostic and source-redaction contracts used by every Mule dialect.

**Architecture:** The pipeline prepares every input as a stable `PreparedSourceInput`, detects Mule project roots, and attaches clone-safe classification to `FileMeta`. The CLI registry retains the user-facing project key separately from the prepared source root. Core source and FTS paths apply a single policy so property values cannot escape through generic rehydration.

**Tech Stack:** TypeScript, Node.js 22, Vitest, `yauzl`, `yazl` (tests only), existing Knowledge-crib soul/index contracts

---

## File map

- `packages/parsers/src/types.ts`: generic file classification and extractor diagnostics.
- `packages/pipeline/src/input/prepared-source.ts`: input identity and cache layout.
- `packages/pipeline/src/input/archive.ts`: bounded, atomic ZIP/JAR extraction.
- `packages/pipeline/src/mule/classify.ts`: project-root, dialect, role, and sensitivity classification.
- `packages/pipeline/src/structure.ts`: classification-aware discovery and secret-safe file hashes.
- `packages/cli/src/registry.ts`: archive identity and prepared-source metadata.
- `packages/cli/src/runtime.ts`: registry overlay from project key to source root.
- `packages/cli/src/cli.ts`: indexing and updating prepared inputs.
- `packages/core/src/source-policy.ts`: allow/redact/deny decisions and key-only property rendering.
- `packages/core/src/source.ts`: policy-aware snippets and body reads.
- `packages/core/src/index/sqlite-index.ts`: policy-aware FTS body composition.
- `packages/pipeline/src/parse*.ts`: aggregate extractor diagnostics in every execution mode.

## GitNexus execution preconditions

Before modifying any existing function, class, or method in this plan, call `gitnexus_impact({ target: "<symbol>", direction: "upstream" })` and report the direct callers, affected processes, and risk to the user. The current index reports `resolveProjectRoot`, `resolveRoot`, `discoverFiles`, and `runParse` as CRITICAL; pause for an explicit warning before their edits. Re-run the analysis at execution time because the index and branch may have changed.

### Task 1: Add classification and diagnostic contracts

**Files:**
- Modify: `packages/parsers/src/types.ts`
- Test: `packages/parsers/src/types.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from 'vitest';
import type { ExtractDiagnostic, FileMeta } from './types.js';

describe('extractor contracts', () => {
  it('carries clone-safe Mule classification and diagnostics', () => {
    const file: FileMeta = {
      path: 'app/src/main/mule/api.xml', bytes: 12, mtime: 1,
      classification: {
        family: 'mule', projectId: 'app', projectRoot: 'app', dialect: 'mule4', role: 'config',
      },
    };
    const diagnostic: ExtractDiagnostic = {
      code: 'mule:unsupported-expression', severity: 'warning', message: 'dynamic flow name',
      file: file.path, projectId: 'app', span: { start: 4, end: 4 },
    };
    expect(structuredClone({ file, diagnostic })).toEqual({ file, diagnostic });
  });
});
```

- [ ] **Step 2: Run the test and verify the contract is absent**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/types.test.ts`

Expected: FAIL during typecheck or collection because `classification` and `ExtractDiagnostic` are not defined.

- [ ] **Step 3: Add the contracts and keep existing extractors source-compatible**

Extend the existing schema import to include `Span`:

```ts
import type { Edge, Node, NodeKind, Span } from '@knowledge-crib/soul-schema';
```

```ts
export type MuleFileRole =
  | 'config' | 'dataweave' | 'mel' | 'raml' | 'munit'
  | 'descriptor' | 'properties' | 'resource';

export interface FileClassification {
  family: 'mule';
  projectId: string;
  projectRoot: string;
  dialect: 'mule3' | 'mule4';
  role: MuleFileRole;
  sensitive?: boolean;
}

export interface ExtractDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  file?: string;
  projectId?: string;
  span?: Span;
}

export interface FileMeta {
  path: string;
  lang?: string;
  bytes: number;
  mtime: number;
  classification?: FileClassification;
}

export interface ExtractResult {
  nodes: Node[];
  edges: Edge[];
  diagnostics?: ExtractDiagnostic[];
}
```

- [ ] **Step 4: Run parser tests and typecheck**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test -- src/types.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/parsers typecheck`

Expected: PASS; all existing extractors remain valid because diagnostics and classification are optional.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/parsers/src/types.ts packages/parsers/src/types.test.ts
git commit -m "feat(parsers): add classified input diagnostics"
```

### Task 2: Detect and classify Mule projects

**Files:**
- Create: `packages/pipeline/src/mule/classify.ts`
- Test: `packages/pipeline/src/mule/classify.test.ts`
- Modify: `packages/pipeline/src/index.ts`

- [ ] **Step 1: Write tests for Mule 3, Mule 4, multiple roots, roles, and ambiguity**

```ts
import { describe, expect, it } from 'vitest';
import { classifyMuleFiles } from './classify.js';

const meta = (path: string) => ({ path, bytes: 1, mtime: 1 });

describe('classifyMuleFiles', () => {
  it('classifies independent Mule 3 and Mule 4 roots', () => {
    const result = classifyMuleFiles([
      meta('modern/mule-artifact.json'), meta('modern/src/main/mule/api.xml'),
      meta('legacy/src/main/app/legacy.xml'), meta('legacy/src/test/munit/order-test.xml'),
    ], new Map([
      ['modern/mule-artifact.json', '{}'],
      ['modern/src/main/mule/api.xml', '<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'],
      ['legacy/src/main/app/legacy.xml', '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><inbound-endpoint/></mule>'],
      ['legacy/src/test/munit/order-test.xml', '<munit:config xmlns:munit="http://www.mulesoft.org/schema/mule/munit"/>'],
    ]));
    expect(result.files.get('modern/src/main/mule/api.xml')).toMatchObject({ dialect: 'mule4', role: 'config' });
    expect(result.files.get('legacy/src/test/munit/order-test.xml')).toMatchObject({ dialect: 'mule3', role: 'munit' });
  });

  it('does not semantically classify a root with conflicting strong signals', () => {
    const result = classifyMuleFiles(
      [meta('app/mule-artifact.json'), meta('app/src/main/app/api.xml')],
      new Map([['app/mule-artifact.json', '{}'], ['app/src/main/app/api.xml', '<mule/>']]),
    );
    expect(result.files.has('app/src/main/app/api.xml')).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'mule:ambiguous-dialect', severity: 'error' }));
  });
});
```

- [ ] **Step 2: Run the focused test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/mule/classify.test.ts`

Expected: FAIL because `classifyMuleFiles` does not exist.

- [ ] **Step 3: Implement deterministic signal scoring and role classification**

```ts
import { dirname } from 'node:path';
import type { ExtractDiagnostic, FileClassification, FileMeta } from '@knowledge-crib/parsers';

export interface MuleClassificationResult {
  files: Map<string, FileClassification>;
  diagnostics: ExtractDiagnostic[];
}

const roleOf = (path: string): FileClassification['role'] => {
  const lower = path.toLowerCase();
  if (lower.includes('/src/test/munit/') && lower.endsWith('.xml')) return 'munit';
  if (/\.(dwl|dw)$/.test(lower)) return 'dataweave';
  if (lower.endsWith('.mel')) return 'mel';
  if (lower.endsWith('.raml')) return 'raml';
  if (/\.(properties|yaml|yml)$/.test(lower)) return 'properties';
  if (/(^|\/)(pom\.xml|mule-artifact\.json|mule-deploy\.properties)$/.test(lower)) return 'descriptor';
  if (lower.endsWith('.xml')) return 'config';
  return 'resource';
};

const markerRoot = (file: FileMeta, text: string): string | undefined => {
  const path = `/${file.path}`;
  for (const marker of ['/mule-artifact.json', '/src/main/mule/', '/src/main/app/', '/src/test/munit/']) {
    const at = path.indexOf(marker);
    if (at >= 0) return file.path.slice(0, Math.max(0, at));
  }
  if (file.path.endsWith('/pom.xml') && /<packaging>mule-(?:application|domain)<\/packaging>/.test(text)) {
    return dirname(file.path) === '.' ? '' : dirname(file.path);
  }
  return undefined;
};

export function classifyMuleFiles(files: FileMeta[], textByPath: ReadonlyMap<string, string>): MuleClassificationResult {
  const roots = [...new Set(files.flatMap((file) => {
    const root = markerRoot(file, textByPath.get(file.path) ?? '');
    return root === undefined ? [] : [root];
  }))].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const grouped = new Map<string, FileMeta[]>();
  for (const file of files) {
    const root = roots.find((candidate) => candidate === '' || file.path === candidate || file.path.startsWith(`${candidate}/`));
    if (root === undefined) continue;
    const list = grouped.get(root) ?? [];
    list.push(file);
    grouped.set(root, list);
  }
  const classified = new Map<string, FileClassification>();
  const diagnostics: ExtractDiagnostic[] = [];
  for (const [root, members] of grouped) {
    let mule3 = 0;
    let mule4 = 0;
    for (const file of members) {
      const text = textByPath.get(file.path) ?? '';
      if (file.path.endsWith('mule-artifact.json') || text.includes('<packaging>mule-application</packaging>')) mule4 += 3;
      if (file.path.includes('/src/main/mule/')) mule4 += 2;
      if (file.path.includes('/src/main/app/') || /inbound-endpoint|exception-strategy/.test(text)) mule3 += 2;
    }
    if (mule3 > 0 && mule4 > 0 && Math.abs(mule3 - mule4) < 3) {
      diagnostics.push({ code: 'mule:ambiguous-dialect', severity: 'error', message: `Conflicting Mule dialect signals under ${root || '.'}`, projectId: root || '.' });
      continue;
    }
    if (mule3 === 0 && mule4 === 0) continue;
    const dialect = mule4 > mule3 ? 'mule4' : 'mule3';
    const projectId = root || '.';
    for (const file of members) {
      const role = roleOf(file.path);
      classified.set(file.path, {
        family: 'mule', projectId, projectRoot: root, dialect, role,
        ...(role === 'properties' && /secure|password|secret|credential/i.test(file.path) ? { sensitive: true } : {}),
      });
    }
  }
  return { files: classified, diagnostics };
}
```

The production implementation may split the scoring helpers within this same file, but it must preserve the tested precedence: descriptors and packaging score 3, layout/namespace signals score 2, and conflicts within two points are rejected. Recognize deployable-JAR root XML and `META-INF/mule-src`; when a packaged XML path and attached-source path describe the same project-relative file, classify only attached source for semantic extraction and emit a bounded `mule:packaged-duplicate-skipped` diagnostic.

- [ ] **Step 4: Export and verify**

Add `export { classifyMuleFiles } from './mule/classify.js';` and its result type to `packages/pipeline/src/index.ts`.

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/mule/classify.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline typecheck`

Expected: PASS.

- [ ] **Step 5: Commit classification**

```bash
git add packages/pipeline/src/mule packages/pipeline/src/index.ts
git commit -m "feat(pipeline): classify Mule project inputs"
```

### Task 3: Prepare directory, ZIP, and JAR inputs safely

**Files:**
- Modify: `packages/pipeline/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/pipeline/src/input/prepared-source.ts`
- Create: `packages/pipeline/src/input/archive.ts`
- Test: `packages/pipeline/src/input/archive.test.ts`
- Modify: `packages/pipeline/src/index.ts`

- [ ] **Step 1: Add runtime and test dependencies**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline add yauzl@^3.2.0 && corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline add -D yazl@^3.3.1 @types/yauzl@^2.10.3 @types/yazl@^2.4.5`

Expected: `packages/pipeline/package.json` and `pnpm-lock.yaml` change without modifying other package manifests.

- [ ] **Step 2: Write archive safety and stable-cache tests**

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { describe, expect, it } from 'vitest';
import { prepareSourceInput } from './prepared-source.js';

async function zip(path: string, entries: Array<[string, string]>): Promise<void> {
  const out = new ZipFile();
  for (const [name, body] of entries) out.addBuffer(Buffer.from(body), name);
  out.end();
  await new Promise<void>((resolve, reject) => {
    const stream = out.outputStream.pipe((await import('node:fs')).createWriteStream(path));
    stream.on('close', resolve).on('error', reject);
  });
}

describe('prepareSourceInput', () => {
  it('persists an archive under a path-keyed cache and refreshes on content change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crib-archive-'));
    const archive = join(root, 'app.jar');
    await zip(archive, [['mule-artifact.json', '{}']]);
    const first = await prepareSourceInput(archive, { importsDir: join(root, 'imports') });
    await zip(archive, [['mule-artifact.json', '{"redeploy":true}']]);
    const second = await prepareSourceInput(archive, { importsDir: join(root, 'imports') });
    expect(second.projectKey).toBe(first.projectKey);
    expect(second.sourceRoot).toBe(first.sourceRoot);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(readFileSync(join(second.sourceRoot, 'mule-artifact.json'), 'utf8')).toContain('redeploy');
  });

  it.each([
    ['ok/escape.xml', '../escape.xml'],
    ['xabsolute.xml', '/absolute.xml'],
    ['xx/rooted.xml', 'C:/rooted.xml'],
  ])('rejects unsafe member %s', async (safeName, member) => {
    const root = mkdtempSync(join(tmpdir(), 'crib-archive-'));
    const archive = join(root, 'bad.zip');
    await zip(archive, [[safeName, '<mule/>']]);
    const bytes = readFileSync(archive);
    writeFileSync(archive, Buffer.from(bytes.toString('latin1').replaceAll(safeName, member), 'latin1'));
    await expect(prepareSourceInput(archive, { importsDir: join(root, 'imports') }))
      .rejects.toThrow(/unsafe archive entry/i);
  });
});
```

- [ ] **Step 3: Run the focused test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/input/archive.test.ts`

Expected: FAIL because `prepareSourceInput` does not exist.

- [ ] **Step 4: Define the prepared-source contract and cache layout**

```ts
export interface PreparedSourceInput {
  projectKey: string;
  sourceRoot: string;
  cribDir: string;
  kind: 'directory' | 'zip' | 'jar';
  fingerprint: string;
  archivePath?: string;
}

export interface PrepareSourceOptions {
  importsDir?: string;
  cribDir?: string;
}

export interface PreparedInputManifest {
  version: 1;
  projectKey: string;
  sourceRoot: string;
  cribDir: string;
  kind: PreparedSourceInput['kind'];
  fingerprint: string;
  archivePath?: string;
}
```

Implement `prepareSourceInput` so directory inputs resolve to the existing `<root>/.crib` behavior. Detect archives by ZIP magic plus a case-insensitive `.zip` or `.jar` extension; reject an archive extension with invalid magic. Archive cache keys are `sha256(realpath-or-resolved-canonical-path)`, fingerprints are SHA-256 of archive bytes, and changed content extracts into `source.staging-<uuid>` before renaming over `source` only after validation succeeds. With an explicit `cribDir`, use that exact directory, `<cribDir>/source-cache`, and `<cribDir>/input.json`; otherwise use `~/.crib/imports/<path-hash>/{source,crib,input.json}`.

Use these exported limits in `archive.ts`:

```ts
export const ARCHIVE_LIMITS = {
  entries: 50_000,
  entryBytes: 100 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  compressionRatio: 100,
} as const;

export function safeArchiveRelativePath(raw: string): string {
  if (raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`unsafe archive entry: ${raw}`);
  }
  const normalized = raw.replaceAll('\\', '/').split('/').filter((part) => part !== '.').join('/');
  if (normalized.split('/').includes('..') || normalized.length === 0) {
    throw new Error(`unsafe archive entry: ${raw}`);
  }
  return normalized;
}
```

During the lazy `yauzl` loop, reject encrypted flags, methods other than stored/deflate, Unix link mode bits, duplicate normalized paths, lower-case path collisions, and any limit breach before opening the output stream. Resolve every destination and verify `destination.startsWith(stagingRoot + sep)`.

- [ ] **Step 5: Export the API and run tests**

Add exports for `prepareSourceInput`, `PreparedSourceInput`, `ARCHIVE_LIMITS`, and `safeArchiveRelativePath` in `packages/pipeline/src/index.ts`.

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/input/archive.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline typecheck`

Expected: PASS; failed extraction leaves any previous `source/` directory untouched.

- [ ] **Step 6: Commit archive preparation**

```bash
git add packages/pipeline/package.json packages/pipeline/src/input packages/pipeline/src/index.ts pnpm-lock.yaml
git commit -m "feat(pipeline): prepare safe archive inputs"
```

### Task 4: Classify discovery and make sensitive hashes key-only

**Files:**
- Modify: `packages/pipeline/src/structure.ts`
- Test: `packages/pipeline/src/pipeline.test.ts`

- [ ] **Step 1: Write a regression test for classified files and secret-safe hashes**

```ts
it('attaches Mule classification without hashing property values', () => {
  writeFileSync(join(root, 'mule-artifact.json'), '{}');
  mkdirSync(join(root, 'src/main/resources'), { recursive: true });
  writeFileSync(join(root, 'src/main/resources/secure.properties'), 'db.password=alpha');
  const first = discoverFiles(root);
  writeFileSync(join(root, 'src/main/resources/secure.properties'), 'db.password=beta');
  const second = discoverFiles(root);
  expect(first.find((f) => f.path.endsWith('secure.properties'))?.classification?.sensitive).toBe(true);
  expect(fileNode(root, first.find((f) => f.path.endsWith('secure.properties'))!).hash)
    .toBe(fileNode(root, second.find((f) => f.path.endsWith('secure.properties'))!).hash);
});
```

- [ ] **Step 2: Run the regression test**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/pipeline.test.ts`

Expected: FAIL because discovery does not classify files and hashes raw content.

- [ ] **Step 3: Add one classification pre-pass and a safe digest projection**

After the ordinary walk, read only Mule candidate descriptors/config/resources up to 2 MiB each, call `classifyMuleFiles`, and assign each returned classification to its matching `FileMeta`. Keep existing ignore behavior unchanged.

Add and use this helper in `fileNode`:

```ts
export function hashableFileText(text: string, file: FileMeta): string {
  if (file.classification?.role !== 'properties') return text;
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.split(/[:=]/, 1)[0]?.trim() ?? '')
    .filter(Boolean)
    .sort()
    .join('\n');
}
```

Store the classification in file-node metadata and set `meta.valueRedacted: true` for property files. Exclude Mule-local generated directories (`reports`, `.mule`, `.mule-artifact`, `target`) only beneath a classified Mule project; do not add `reports` to global ignores.

- [ ] **Step 4: Run discovery and existing gitignore tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/pipeline.test.ts src/gitignore.test.ts`

Expected: PASS, including existing non-Mule `reports/` discovery behavior.

- [ ] **Step 5: Commit classified discovery**

```bash
git add packages/pipeline/src/structure.ts packages/pipeline/src/pipeline.test.ts packages/pipeline/src/gitignore.test.ts
git commit -m "feat(pipeline): classify Mule discovery safely"
```

### Task 5: Preserve archive identity in CLI resolution and registry

**Files:**
- Modify: `packages/cli/src/registry.ts`
- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/src/registry.test.ts`
- Test: `packages/cli/src/runtime.test.ts`
- Test: `packages/cli/src/cli.test.ts`

- [ ] **Step 1: Write registry and resolution tests**

```ts
it('resolves an archive project key to its persistent source root', () => {
  registerProject('/work/app.zip', {
    repoId: 'r1', cribDir: '/cache/crib', sourceRoot: '/cache/source',
    sourceArchive: '/work/app.zip', sourceFingerprint: 'sha256:abc', env,
  });
  expect(resolveProjectRoot({ explicitRoot: '/work/app.zip', env })).toEqual({
    projectKey: '/work/app.zip', repoRoot: '/cache/source', cribDir: '/cache/crib',
    sourceArchive: '/work/app.zip', sourceFingerprint: 'sha256:abc',
  });
});
```

Add a CLI test that indexes a generated ZIP, deletes no cache after command completion, and then executes `source` or `context` using the archive path.

- [ ] **Step 2: Run the focused CLI tests**

Run: `corepack pnpm@9.15.0 --filter knowledge-crib test -- src/registry.test.ts src/runtime.test.ts src/cli.test.ts`

Expected: FAIL because archive fields and preparation are absent.

- [ ] **Step 3: Extend backward-compatible registry types**

```ts
export interface RegisteredProject {
  repoId: string;
  cribDir: string;
  vcsHead?: string;
  addedAt: string;
  sourceRoot?: string;
  sourceArchive?: string;
  sourceFingerprint?: string;
}

export interface RegisterOpts {
  repoId: string;
  cribDir: string;
  vcsHead?: string;
  sourceRoot?: string;
  sourceArchive?: string;
  sourceFingerprint?: string;
  addedAt?: string;
  env?: NodeJS.ProcessEnv;
}
```

Copy only defined optional fields during `registerProject`; old registry JSON must continue resolving directories.

- [ ] **Step 4: Separate project key from repository/source root**

```ts
export interface ResolvedRoot {
  projectKey: string;
  repoRoot: string;
  cribDir: string;
  sourceArchive?: string;
  sourceFingerprint?: string;
}
```

In `resolveProjectRoot`, canonicalize the explicit input as `projectKey`, look it up in the registry, and return `registered.sourceRoot ?? projectKey` as `repoRoot`. All existing directory paths therefore keep `projectKey === repoRoot`.

- [ ] **Step 5: Prepare inputs only for index/update commands**

Before `cmdIndex` opens the soul, call `prepareSourceInput` and pass its `sourceRoot` into discovery/parsing and its `cribDir` into storage. Register the entry under `projectKey` after the index succeeds. For `cmdUpdate`, archive input compares its new fingerprint and performs the same full-index path when changed; unchanged archives print a no-op. Return a clear error for `watch`, ownership, or Git-delta commands when `sourceArchive` is present.

Use this registration call:

```ts
registerProject(input.projectKey, {
  repoId: soul.getManifest().repo.id,
  cribDir: input.cribDir,
  sourceRoot: input.sourceRoot,
  ...(input.archivePath ? { sourceArchive: input.archivePath, sourceFingerprint: input.fingerprint } : {}),
});
```

- [ ] **Step 6: Run CLI tests and typecheck**

Run: `corepack pnpm@9.15.0 --filter knowledge-crib test -- src/registry.test.ts src/runtime.test.ts src/cli.test.ts && corepack pnpm@9.15.0 --filter knowledge-crib typecheck`

Expected: PASS for directory and archive project resolution.

- [ ] **Step 7: Commit CLI input identity**

```bash
git add packages/cli/src/registry.ts packages/cli/src/runtime.ts packages/cli/src/cli.ts packages/cli/src/registry.test.ts packages/cli/src/runtime.test.ts packages/cli/src/cli.test.ts
git commit -m "feat(cli): persist archive source identity"
```

### Task 6: Enforce property redaction in source and FTS

**Files:**
- Create: `packages/core/src/source-policy.ts`
- Modify: `packages/core/src/source.ts`
- Modify: `packages/core/src/index/sqlite-index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/source.test.ts`
- Test: `packages/core/src/index/sqlite-index.test.ts`
- Test: `packages/mcp/src/verbs.test.ts`

- [ ] **Step 1: Write tests proving values cannot be returned or searched**

```ts
it('renders property keys but never values', () => {
  const node = { id: 'f', kind: 'file', name: 'secure.properties', file: 'secure.properties',
    span: { start: 1, end: 2 }, meta: { sourcePolicy: 'redact-properties' } } as Node;
  writeFileSync(join(root, 'secure.properties'), 'db.user=alice\ndb.password=swordfish');
  expect(rehydrateBody(root, node).text).toBe('db.user=<redacted>\ndb.password=<redacted>');
  expect(rehydrate(root, node)).toBe('db.user=<redacted>');
});
```

In the SQLite test, build from a soul containing that node and assert query `db.password` finds it while query `swordfish` does not. In the MCP test, assert `source` returns redacted keys.

Add an XML node with `meta.sourcePolicy: 'redact-mule-secrets'` and source `<http:request password="xml-canary" token="${api.token}"/>`. Assert snippets, body reads, and FTS never contain `xml-canary`, while the placeholder key `api.token` remains searchable.

- [ ] **Step 2: Run core and MCP tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/core test -- src/source.test.ts src/index/sqlite-index.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/mcp test -- src/verbs.test.ts`

Expected: FAIL because source and FTS read raw files.

- [ ] **Step 3: Add a single source-policy implementation**

```ts
import type { Node } from '@knowledge-crib/soul-schema';

export type SourcePolicy = 'allow' | 'redact-properties' | 'redact-mule-secrets' | 'deny';

export function sourcePolicy(node: Node | undefined): SourcePolicy {
  const value = node?.meta?.sourcePolicy;
  if (value === 'deny' || value === 'redact-properties' || value === 'redact-mule-secrets') return value;
  if (node?.meta?.valueRedacted === true || node?.type === 'property') return 'redact-properties';
  return 'allow';
}

export function redactPropertyText(text: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return '';
    const at = line.search(/[:=]/);
    return at < 0 ? `${trimmed}=<redacted>` : `${line.slice(0, at).trim()}=<redacted>`;
  }).filter(Boolean).join('\n');
}

export function redactMuleSecretAttributes(text: string): string {
  const secret = /(password|secret|token|credential|private[-_]?key)/i;
  return text.replace(/([:\w.-]+)\s*=\s*(["'])(.*?)\2/g, (whole, name, quote, value) => {
    if (!secret.test(name)) return whole;
    const placeholder = value.match(/^\$\{([^}]+)\}$/)?.[1] ?? value.match(/^secure::(.+)$/)?.[1];
    return `${name}=${quote}${placeholder ? `\${${placeholder}}` : '<redacted>'}${quote}`;
  });
}
```

Apply `deny` before any disk read. Apply `redactPropertyText` or `redactMuleSecretAttributes` before snippet selection, body budgeting, and `composeSearchableBody`. Mark ordinary property files `redact-properties`, encrypted/secure property files and key/trust stores `deny`, and Mule XML configuration files `redact-mule-secrets` in `fileNode` metadata. Every node emitted from a classified file must copy the file's source policy; secure-property symbols omit spans entirely.

- [ ] **Step 4: Verify every read path**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/core test -- src/source.test.ts src/index/sqlite-index.test.ts && corepack pnpm@9.15.0 --filter @knowledge-crib/mcp test -- src/verbs.test.ts`

Expected: PASS; neither `source`, snippets, dossier rehydration, nor FTS contains the test value.

- [ ] **Step 5: Commit source policy**

```bash
git add packages/core/src/source-policy.ts packages/core/src/source.ts packages/core/src/index/sqlite-index.ts packages/core/src/index.ts packages/core/src/source.test.ts packages/core/src/index/sqlite-index.test.ts packages/mcp/src/verbs.test.ts
git commit -m "feat(core): enforce source redaction policy"
```

### Task 7: Aggregate diagnostics in serial, concurrent, and worker parsing

**Files:**
- Modify: `packages/pipeline/src/parse.ts`
- Modify: `packages/pipeline/src/parse-concurrent.ts`
- Modify: `packages/pipeline/src/parse-pool.ts`
- Modify: `packages/pipeline/src/parse-worker.ts`
- Test: `packages/pipeline/src/parse-concurrent.test.ts`
- Test: `packages/pipeline/src/pipeline.test.ts`

- [ ] **Step 1: Add parity tests for ordered diagnostics**

Create a custom extractor returning one warning per file. Assert serial and concurrent results contain the same diagnostics in discovery order, and that existing `filesParsed`, `nodesAdded`, and `edgesAdded` counts do not change.

```ts
expect(serial.diagnostics).toEqual([
  { code: 'test:first', severity: 'warning', message: 'a', file: 'a.x' },
  { code: 'test:second', severity: 'warning', message: 'b', file: 'b.x' },
]);
expect(concurrent.diagnostics).toEqual(serial.diagnostics);
expect(runWithLimitOne.diagnostics).toHaveLength(1);
expect(runWithLimitOne.diagnosticsTruncated).toBe(1);
expect(runWithLimitOne.bySeverity.warning).toBe(2);
expect(runWithLimitOne.byCode).toEqual({ 'test:first': 1, 'test:second': 1 });
```

- [ ] **Step 2: Run parse tests**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/parse-concurrent.test.ts src/pipeline.test.ts`

Expected: FAIL because `ParseStats` has no diagnostics.

- [ ] **Step 3: Extend stats and worker messages**

```ts
export interface ParseStats {
  filesParsed: number;
  nodesAdded: number;
  edgesAdded: number;
  diagnostics: ExtractDiagnostic[];
  diagnosticsTruncated: number;
  byExtractor: Record<string, { files: number; diagnostics: number }>;
  byCode: Record<string, number>;
  bySeverity: Record<ExtractDiagnostic['severity'], number>;
}
```

Add `diagnosticLimit?: number` to parse options and use `export const DEFAULT_DIAGNOSTIC_LIMIT = 1_000`. Count every diagnostic in `byCode`, `bySeverity`, and `byExtractor`, retain only the first bounded records in discovery order, and report the remainder in `diagnosticsTruncated`. Include diagnostics and extractor name in worker responses. The parent process sorts worker results by original file index before both persistence and diagnostic aggregation, preserving deterministic output.

- [ ] **Step 4: Run all execution-mode tests**

Run: `KCRIB_PARALLEL=0 corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/pipeline.test.ts && KCRIB_PARALLEL=1 corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test -- src/parse-concurrent.test.ts`

Expected: PASS with byte-identical graph output and equal diagnostics.

- [ ] **Step 5: Commit diagnostics aggregation**

```bash
git add packages/pipeline/src/parse.ts packages/pipeline/src/parse-concurrent.ts packages/pipeline/src/parse-pool.ts packages/pipeline/src/parse-worker.ts packages/pipeline/src/parse-concurrent.test.ts packages/pipeline/src/pipeline.test.ts
git commit -m "feat(pipeline): aggregate extractor diagnostics"
```

### Task 8: Verify the foundation phase

- [ ] **Step 1: Run package gates**

Run: `corepack pnpm@9.15.0 --filter @knowledge-crib/parsers test && corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline test && corepack pnpm@9.15.0 --filter @knowledge-crib/core test && corepack pnpm@9.15.0 --filter knowledge-crib test`

Expected: all four suites PASS.

- [ ] **Step 2: Run typecheck and build**

Run: `corepack pnpm@9.15.0 -r typecheck && corepack pnpm@9.15.0 -r build`

Expected: PASS.

- [ ] **Step 3: Verify the dependency licenses are packaged**

Add `yauzl`, `saxes`, and `yaml` notices when each dependency enters the tree; at this phase `yauzl` must appear in the repository NOTICE/license inventory. Run the repository package-content or notice check documented in the root scripts.

- [ ] **Step 4: Check graph impact before the phase commit**

Call: `gitnexus_detect_changes()`

Expected: changed flows are limited to input preparation, root resolution, discovery, source rehydration/indexing, and parse result aggregation.
