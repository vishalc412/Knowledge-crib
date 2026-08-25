/**
 * Mule descriptors — parses the three project-adjacent files a Mule app carries WITHOUT ever
 * materializing a resolved secret value: Java `.properties` (keys only), `mule-artifact.json`
 * (the deploy descriptor), and the Maven `pom.xml` (connector/module dependencies + the
 * `<properties>` key set). POM XML parsing reuses the secure saxes front ({@link parseMuleXml}) so
 * DTD/XXE is rejected outright; JSON parsing reports invalid input as a diagnostic rather than
 * throwing.
 *
 * SECURITY (locked constraint): property values are NEVER part of any return type or diagnostic.
 * `parseProperties` returns keys only; `parsePom` returns the `<properties>` keys (never their
 * text) and dependency `versionRef`s verbatim (`${http.version}` stays a key reference — the
 * resolved value lives in a properties file / build the indexer never opens). A literal version
 * (`1.2.0`) is kept because it is a public coordinate, not a secret.
 */
import type { ExtractDiagnostic } from '../types.js';
import type { MuleXmlElement } from './ast.js';
import { parseMuleXml } from './xml.js';

/** `parseProperties` result: the unique property keys, sorted; no values ever stored. */
export interface MulePropertyResult {
  keys: string[];
  diagnostics: ExtractDiagnostic[];
}

/** A Maven dependency declared in a POM. `versionRef` is the `<version>` text verbatim — a property
 *  reference (`${…}`) stays a reference; a literal coordinate stays a coordinate. Never resolved. */
export interface PomDependency {
  groupId: string;
  artifactId: string;
  versionRef: string;
}

/** `parsePom` result: dependencies + the `<properties>` key set; no property values stored. */
export interface PomResult {
  dependencies: PomDependency[];
  propertyKeys: string[];
  diagnostics: ExtractDiagnostic[];
}

/** `parseMuleArtifact` result: the deploy descriptor fields the graph indexes, plus diagnostics. */
export interface MuleArtifactResult {
  minMuleVersion?: string;
  requiredProduct?: string;
  minJavaVersion?: string;
  classLoaderModelLoaderId?: string;
  diagnostics: ExtractDiagnostic[];
}

/**
 * Parse a Java `.properties` source into its unique key set. Values are dropped on read — the
 * indexer stores KEYS AND REFERENCES ONLY, never the resolved value (which may be a secret). Lines
 * without a `=`/`:` delimiter or with an empty key produce a diagnostic but do not throw.
 */
export function parseProperties(source: string): MulePropertyResult {
  const keys = new Set<string>();
  const diagnostics: ExtractDiagnostic[] = [];
  const lines = source.split(/\r\n|\n|\r/);
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    // Split on the first `=` or `:`. A leading delimiter (empty key) is malformed.
    const m = /^([^=:]*?)\s*[=:]\s*(.*)$/.exec(trimmed);
    if (!m) {
      // No delimiter at all — a bare line is not a valid property entry.
      diagnostics.push({
        code: 'mule:properties-no-delimiter',
        severity: 'warning',
        message: 'Property line has no key=value delimiter',
        span: { start: idx + 1, end: idx + 1 },
      });
      continue;
    }
    const key = (m[1] ?? '').trim();
    if (key === '') {
      diagnostics.push({
        code: 'mule:properties-empty-key',
        severity: 'warning',
        message: 'Property line has an empty key',
        span: { start: idx + 1, end: idx + 1 },
      });
      continue;
    }
    keys.add(key);
    // `m[2]` (the value) is intentionally discarded.
  }
  return { keys: [...keys].sort(), diagnostics };
}

/** Parse a `mule-artifact.json` deploy descriptor. Invalid JSON is a diagnostic, never a throw.
 *  Only the graph-relevant scalar fields are lifted; nested structures (classLoaderModelLoader…) are
 *  reduced to their `id` where present. */
export function parseMuleArtifact(source: string): MuleArtifactResult {
  const diagnostics: ExtractDiagnostic[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    diagnostics.push({
      code: 'mule:invalid-artifact-json',
      severity: 'warning',
      message: `mule-artifact.json is not valid JSON${detail}`,
    });
    return { diagnostics };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push({
      code: 'mule:invalid-artifact-shape',
      severity: 'warning',
      message: 'mule-artifact.json is not a JSON object',
    });
    return { diagnostics };
  }
  const obj = parsed as Record<string, unknown>;
  const result: MuleArtifactResult = { diagnostics };
  if (typeof obj.minMuleVersion === 'string') result.minMuleVersion = obj.minMuleVersion;
  if (typeof obj.requiredProduct === 'string') result.requiredProduct = obj.requiredProduct;
  if (typeof obj.minJavaVersion === 'string') result.minJavaVersion = obj.minJavaVersion;
  // classLoaderModelLoaderDescriptor:{id:…} is reduced to just its id (a public loader name).
  const clm = obj.classLoaderModelLoaderDescriptor;
  if (clm !== null && typeof clm === 'object' && !Array.isArray(clm)) {
    const id = (clm as Record<string, unknown>).id;
    if (typeof id === 'string') result.classLoaderModelLoaderId = id;
  }
  return result;
}

/** Find the first child element with the given local name (namespace-agnostic — POM elements all
 *  share the Maven namespace). Returns undefined when absent. */
function findChild(parent: MuleXmlElement, local: string): MuleXmlElement | undefined {
  for (const child of parent.children) {
    if (child.local === local) return child;
  }
  return undefined;
}

/** Find all child elements with the given local name. */
function findChildren(parent: MuleXmlElement, local: string): MuleXmlElement[] {
  return parent.children.filter((c) => c.local === local);
}

/** Coalesce the direct text of an element (its own text node, not descendants). */
function textOf(el: MuleXmlElement | undefined): string {
  if (!el) return '';
  return el.text.trim();
}

/** Parse a Maven `pom.xml` into dependencies + the `<properties>` key set. POM XML is parsed through
 *  {@link parseMuleXml} (DTD/XXE rejected); malformed XML is a diagnostic, never a throw. Property
 *  VALUES are never stored — only the keys; dependency versions are kept verbatim as `versionRef`. */
export function parsePom(source: string): PomResult {
  const dependencies: PomDependency[] = [];
  const propertyKeys: string[] = [];
  const diagnostics: ExtractDiagnostic[] = [];

  let doc: ReturnType<typeof parseMuleXml>;
  try {
    doc = parseMuleXml(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      code: 'mule:invalid-pom-xml',
      severity: 'warning',
      message: `pom.xml is not well-formed XML: ${message}`,
    });
    return { dependencies, propertyKeys, diagnostics };
  }

  const root = doc.root;
  // <properties> — collect the child element local names as keys; their text (the value) is dropped.
  const properties = findChild(root, 'properties');
  if (properties) {
    for (const child of properties.children) {
      if (child.local) propertyKeys.push(child.local);
    }
  }

  // <dependencies><dependency> — lift groupId/artifactId/version verbatim.
  const depsEl = findChild(root, 'dependencies');
  const depEls = depsEl ? findChildren(depsEl, 'dependency') : [];
  for (const dep of depEls) {
    const groupId = textOf(findChild(dep, 'groupId'));
    const artifactId = textOf(findChild(dep, 'artifactId'));
    const version = textOf(findChild(dep, 'version'));
    if (groupId === '' && artifactId === '') continue; // not a meaningful dependency entry
    dependencies.push({ groupId, artifactId, versionRef: version });
  }

  return { dependencies, propertyKeys, diagnostics: [...diagnostics, ...doc.diagnostics] };
}
