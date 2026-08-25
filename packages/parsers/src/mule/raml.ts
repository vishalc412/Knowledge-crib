/**
 * RAML parser — extracts the API contract structure a RAML file declares (resources, methods,
 * types, traits, security schemes, resource types) plus `!include` references, WITHOUT ever
 * reading the included files. The YAML engine never touches the filesystem; `!include` is a tag
 * the indexer records as a reference path so the resolver can later resolve it against the project
 * file set. RAML's leading `#%RAML 1.0` is a YAML comment, so the engine parses the rest natively.
 *
 * SECURITY (locked constraint): includes are KEYS/PATHS ONLY — the referenced file is never opened
 * or inlined here; no include contents, no secrets. Alias expansion is capped (`maxAliasCount`)
 * and merge keys are disabled so a hostile or typo'd RAML cannot explode the graph via `<<` merges
 * or self-referencing aliases.
 */
import type { Span } from '@knowledge-crib/soul-schema';
import { type Document, type Node, type Scalar, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { ExtractDiagnostic } from '../types.js';

/** HTTP verbs RAML treats as methods on a resource. */
const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** Reference kinds surfaced for the resolver: includes + named-contract references (type/trait/…). */
export type RamlReferenceKind = 'include' | 'type' | 'trait' | 'securityScheme' | 'resourceType';

/** A reference surfaced from the RAML — a name/path, never resolved contents. */
export interface RamlReference {
  kind: RamlReferenceKind;
  name: string;
}

/** A method (HTTP verb) declared on a resource. Carries the verb only — the span lives on the
 *  enclosing resource (the graph key for a method is its resource path + verb). */
export interface RamlMethod {
  method: string;
}

/** A resource (a path-segment tree). Nested resources carry the concatenated absolute path. */
export interface RamlResource {
  path: string;
  methods: RamlMethod[];
  resources: RamlResource[];
  span?: Span;
}

/** `parseRaml` result — the contract structure + references + diagnostics; never include contents. */
export interface RamlResult {
  title?: string;
  version?: string;
  baseUri?: string;
  mediaType: string[];
  resources: RamlResource[];
  types: string[];
  traits: string[];
  securitySchemes: string[];
  resourceTypes: string[];
  includes: string[];
  references: RamlReference[];
  diagnostics: ExtractDiagnostic[];
}

/** YAML parse options shared by every call — alias-capped, merge-disabled, `!include` as a sentinel. */
const YAML_OPTIONS = {
  customTags: [
    {
      tag: '!include',
      resolve: (value: string) => ({ include: String(value) }),
    },
  ],
  maxAliasCount: 50,
  merge: false,
};

/** Coerce a YAML scalar node to its primitive string value (numbers/bools stringify). */
function scalarString(node: Scalar | null | undefined): string | undefined {
  if (!node || !isScalar(node)) return undefined;
  const v = node.value;
  if (v === null || v === undefined) return undefined;
  return String(v);
}

/** Span of a YAML node, derived from its parsed character range (line approximated 1-based). */
function spanOf(node: Node | null | undefined, lineStarts: number[]): Span | undefined {
  if (!node || !node.range) return undefined;
  const start = node.range[0];
  if (start === undefined || start === null) return undefined;
  return { start: lineOf(start, lineStarts), end: lineOf(node.range[1] ?? start, lineStarts) };
}

/** Binary-search the line (1-based) containing a character offset. */
function lineOf(offset: number, lineStarts: number[]): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midVal = lineStarts[mid];
    if (midVal === undefined) {
      lo = mid + 1;
      continue;
    }
    if (midVal <= offset) {
      const next = lineStarts[mid + 1];
      if (next === undefined || next > offset) return mid + 1; // 1-based
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return 1;
}

/** Precompute the character offset of the start of each line (offset 0 for line 1). */
function computeLineStarts(source: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') {
      starts.push(i + 1);
    } else if (ch === '\r') {
      // CRLF: the \n follows and is handled by its own branch; lone CR also ends a line.
      if (source[i + 1] !== '\n') starts.push(i + 1);
    }
  }
  return starts;
}

/** A de-duplicated ordered accumulator for string sets (types/traits/…). */
class StringSet {
  private seen = new Set<string>();
  private items: string[] = [];
  add(value: string): void {
    if (this.seen.has(value)) return;
    this.seen.add(value);
    this.items.push(value);
  }
  toSorted(): string[] {
    return [...this.items].sort();
  }
}

/**
 * Walk a RAML resource map: collect its HTTP-verb methods, recurse into nested `/`-prefixed
 * resources (concatenating the absolute path), and record `type`/`is`/`securedBy` references found
 * on methods. The `include` sentinel objects produced by the `!include` custom tag are collected
 * by the top-level tree walk, not here.
 */
function walkResource(
  resourceNode: Node | null,
  basePath: string,
  out: {
    resources: RamlResource[];
    references: RamlReference[];
  },
  lineStarts: number[],
): RamlResource {
  const resource: RamlResource = { path: basePath, methods: [], resources: [] };
  if (!resourceNode || !isMap(resourceNode)) {
    out.resources.push(resource);
    return resource;
  }
  resource.span = spanOf(resourceNode, lineStarts);
  for (const pair of resourceNode.items) {
    const key = scalarString(pair.key as Scalar | null);
    if (!key) continue;
    if (HTTP_VERBS.has(key)) {
      resource.methods.push({ method: key });
      collectMethodReferences(pair.value as Node | null, out.references);
      continue;
    }
    if (key.startsWith('/')) {
      const nestedPath = basePath + key;
      out.resources.push(walkResource(pair.value as Node | null, nestedPath, out, lineStarts));
    }
  }
  out.resources.push(resource);
  return resource;
}

/** RAML primitive type names that are NOT named-type references (string, integer, …). A `type:`
 *  whose value is one of these is a primitive annotation, not a reference to a declared type. */
const PRIMITIVE_TYPES = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'nil',
  'any',
  'date-only',
  'time-only',
  'datetime',
  'datetime-only',
  'file',
  'object',
  'array',
]);

/** Record named references found ANYWHERE inside a method subtree: `type:` (named type ref),
 *  `is:` (trait refs), `securedBy:` (securityScheme refs). The method body nests under
 *  `responses/<code>/body/<media>/type`, so this recurses the whole method map. Duplicate
 *  references across the doc are kept — each is a distinct call site for the resolver. */
function collectMethodReferences(methodNode: Node | null, references: RamlReference[]): void {
  if (!methodNode) return;
  if (isMap(methodNode)) {
    for (const pair of methodNode.items) {
      const key = scalarString(pair.key as Scalar | null);
      if (key === 'type') {
        const val = pair.value;
        // `type:` may be a bare name, a primitive, or a map (inline type) — only bare non-primitive
        // names are type references.
        if (val && isScalar(val)) {
          const name = scalarString(val as Scalar | null);
          if (name && !PRIMITIVE_TYPES.has(name)) references.push({ kind: 'type', name });
        }
        continue; // do not recurse into an inline type map — its inner `type:` keys are primitives
      }
      if (key === 'is') {
        recordNameList(pair.value as Node | null, references, 'trait');
        continue;
      }
      if (key === 'securedBy') {
        recordNameList(pair.value as Node | null, references, 'securityScheme');
        continue;
      }
      collectMethodReferences(pair.value as Node | null, references);
    }
    return;
  }
  if (isSeq(methodNode)) {
    for (const item of methodNode.items) {
      collectMethodReferences(item as Node | null, references);
    }
  }
}

/** Record a `is:`/`securedBy:` value (a scalar name or a sequence of names) as references. */
function recordNameList(
  value: Node | null,
  references: RamlReference[],
  kind: RamlReferenceKind,
): void {
  if (value && isSeq(value)) {
    for (const item of value.items) {
      const name = scalarString(item as Scalar | null);
      if (name) references.push({ kind, name });
    }
  } else {
    const name = scalarString(value as Scalar | null);
    if (name) references.push({ kind, name });
  }
}

/** Walk the WHOLE tree collecting `!include` sentinels (paths only). The custom tag resolved the
 *  tagged scalar's value to `{ include: <path> }`; we surface the path and never open the file. */
function collectIncludes(
  node: Node | null,
  includes: StringSet,
  references: RamlReference[],
): void {
  if (!node) return;
  if (isScalar(node)) {
    const v = node.value;
    if (v !== null && typeof v === 'object' && 'include' in v) {
      const path = String((v as { include: unknown }).include);
      includes.add(path);
      references.push({ kind: 'include', name: path });
    }
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      collectIncludes(pair.key as Node | null, includes, references);
      collectIncludes(pair.value as Node | null, includes, references);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      collectIncludes(item as Node | null, includes, references);
    }
  }
}

/** Collect the names of a top-level named-contract map (types / traits / securitySchemes / resourceTypes).
 *  Each entry's KEY is the contract name; the value (often a map or an `!include` sentinel) is not
 *  expanded. */
function collectNamedMap(mapNode: Node | null, names: StringSet): void {
  if (!mapNode || !isMap(mapNode)) return;
  for (const pair of mapNode.items) {
    const name = scalarString(pair.key as Scalar | null);
    if (name) names.add(name);
  }
}

/**
 * Parse a RAML 1.0 source into its contract structure. YAML parse errors become diagnostics; the
 * walker still drains whatever the engine produced. Includes are recorded as path references —
 * the referenced file is NEVER opened or inlined here (the resolver owns cross-file resolution).
 */
export function parseRaml(source: string): RamlResult {
  const lineStarts = computeLineStarts(source);
  const includes = new StringSet();
  const references: RamlReference[] = [];
  const result: RamlResult = {
    mediaType: [],
    resources: [],
    types: [],
    traits: [],
    securitySchemes: [],
    resourceTypes: [],
    includes: [],
    references,
    diagnostics: [],
  };

  let doc: Document;
  try {
    doc = parseDocument(source, YAML_OPTIONS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.diagnostics.push({
      code: 'mule:invalid-raml-yaml',
      severity: 'warning',
      message: `RAML is not valid YAML: ${message}`,
    });
    return result;
  }

  // YAML engine errors (bad indentation, …) are diagnostics, not throws.
  for (const err of doc.errors) {
    result.diagnostics.push({
      code: 'mule:invalid-raml-yaml',
      severity: 'warning',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const root = doc.contents;
  if (!root || !isMap(root)) {
    // Not a map (a scalar or empty document) — no contract structure to lift.
    if (result.diagnostics.length === 0 && root !== null) {
      result.diagnostics.push({
        code: 'mule:invalid-raml-shape',
        severity: 'info',
        message: 'RAML root is not a mapping (expected a resource/type document)',
      });
    }
    return result;
  }

  // Include sentinels can appear anywhere in the tree (types, traits, nested) — drain them all.
  collectIncludes(root, includes, references);
  result.includes = includes.toSorted();

  for (const pair of root.items) {
    const key = scalarString(pair.key as Scalar | null);
    if (!key) continue;

    switch (key) {
      case 'title':
        result.title = scalarString(pair.value as Scalar | null);
        break;
      case 'version':
        result.version = scalarString(pair.value as Scalar | null);
        break;
      case 'baseUri':
        result.baseUri = scalarString(pair.value as Scalar | null);
        break;
      case 'mediaType': {
        const val = pair.value;
        if (val && isSeq(val)) {
          for (const item of val.items) {
            const m = scalarString(item as Scalar | null);
            if (m) result.mediaType.push(m);
          }
        } else {
          const m = scalarString(val as Scalar | null);
          if (m) result.mediaType.push(m);
        }
        break;
      }
      case 'types': {
        const names = new StringSet();
        collectNamedMap(pair.value as Node | null, names);
        for (const n of names.toSorted()) result.types.push(n);
        break;
      }
      case 'traits': {
        const names = new StringSet();
        collectNamedMap(pair.value as Node | null, names);
        for (const n of names.toSorted()) result.traits.push(n);
        break;
      }
      case 'securitySchemes': {
        const names = new StringSet();
        collectNamedMap(pair.value as Node | null, names);
        for (const n of names.toSorted()) result.securitySchemes.push(n);
        break;
      }
      case 'resourceTypes': {
        const names = new StringSet();
        collectNamedMap(pair.value as Node | null, names);
        for (const n of names.toSorted()) result.resourceTypes.push(n);
        break;
      }
      default:
        if (key.startsWith('/')) {
          // Top-level resource — walk it (its nested resources are emitted alongside it).
          walkResource(pair.value as Node | null, key, result, lineStarts);
        }
        break;
    }
  }

  return result;
}

// Re-export the YAML shape consumers (extractor/resolver) may need for type-narrowing.
export { isMap, isSeq, isScalar } from 'yaml';
export type { Document, Node, Pair, YAMLMap, Scalar } from 'yaml';
