/**
 * Mule project classification (Foundation Task 2).
 *
 * Deterministically groups Mule files into independent projects, detects the Mule 3 vs Mule 4
 * dialect for each, and assigns a clone-safe {@link FileClassification} per file. Pure over its
 * inputs — never reads disk; callers pass the discovered FileMeta + a path→text map (descriptors
 * + a small config peek only). Output drives MuleExtractor.support() dispatch (disjoint from
 * generic XML/resource files) and the source-policy layer.
 *
 * Scoring precedence (tested): descriptors/packaging score 3, layout/namespace signals score 2.
 * A root with conflicting strong signals within two points is rejected as ambiguous rather than
 * guessed — Mule 3 and Mule 4 share an XML vocabulary, so a wrong dialect would misroute every
 * downstream parser.
 */
import type { ExtractDiagnostic, FileClassification, FileMeta } from '@knowledge-crib/parsers';

export interface MuleClassificationResult {
  /** file.path → classification, only for files that belong to a detected Mule project. */
  files: Map<string, FileClassification>;
  diagnostics: ExtractDiagnostic[];
}

/** Strong Mule 3 XML signals: legacy transport namespaces + endpoint/exception-strategy elements. */
const MULE3_XML_SIGNALS = [
  /schema\/mule\/(?:vm|jms|http|https|file|ftp|sftp|servlet|tcp|udp|jdbc|mq)\//,
  /<(?:[A-Za-z][\w.-]*:)?(?:inbound-endpoint|outbound-endpoint|catch-exception-strategy|choice-exception-strategy|rollback-exception-strategy|reference-exception-strategy)\b/,
] as const;

/** Sensitive property filename patterns → source policy `deny` (never persisted, never hashed by value). */
const SENSITIVE_NAME = /secure|password|secret|credential|keystore|truststore|jks/i;

const roleOf = (path: string): FileClassification['role'] => {
  const lower = path.toLowerCase();
  if (lower.includes('/src/test/munit/') && lower.endsWith('.xml')) return 'munit';
  if (/\.(dwl|dw)$/.test(lower)) return 'dataweave';
  if (lower.endsWith('.mel')) return 'mel';
  if (lower.endsWith('.raml')) return 'raml';
  if (/\.(properties|yaml|yml)$/.test(lower)) return 'properties';
  if (
    /(?:^|\/)(?:pom\.xml|mule-artifact\.json|mule-deploy\.properties|mule-project\.xml)$/.test(
      lower,
    )
  )
    return 'descriptor';
  if (lower.endsWith('.xml')) return 'config';
  return 'resource';
};

/** Resolve the Mule project root for a file by matching known structural markers, or undefined.
 *  Returns the repo-relative POSIX root with NO trailing slash ('' for the repo root). */
const MARKERS = [
  '/mule-artifact.json',
  '/mule-deploy.properties',
  '/mule-project.xml',
  '/src/main/mule/',
  '/src/main/app/',
  '/src/test/munit/',
] as const;
const markerRoot = (file: FileMeta, text: string): string | undefined => {
  for (const marker of MARKERS) {
    if (file.path === marker.slice(1)) return ''; // top-level marker file → repo root
    const at = file.path.indexOf(marker);
    if (at >= 0) return file.path.slice(0, at); // nested marker → root before it (marker starts with '/')
  }
  // A Mule-packaged pom.xml (mule-application/mule-domain) anchors a project even without the
  // standard src/ layout (deployable JARs, flat projects).
  if (
    file.path.endsWith('/pom.xml') &&
    /<packaging>mule-(?:application|domain)<\/packaging>/.test(text)
  ) {
    return dirname(file.path);
  }
  return undefined;
};

/** `dirname` that treats a bare top-level filename as the repo root ('') rather than '.'. */
function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function classifyMuleFiles(
  files: FileMeta[],
  textByPath: ReadonlyMap<string, string>,
): MuleClassificationResult {
  // 1. Collect candidate roots from every marker-bearing file (longest first so nested roots win).
  const roots = [
    ...new Set(
      files.flatMap((file) => {
        const root = markerRoot(file, textByPath.get(file.path) ?? '');
        return root === undefined ? [] : [root];
      }),
    ),
  ].sort((a, b) => b.length - a.length || a.localeCompare(b));

  // 2. Assign every file to its deepest enclosing root.
  const grouped = new Map<string, FileMeta[]>();
  for (const file of files) {
    const root = roots.find(
      (candidate) =>
        candidate === '' || file.path === candidate || file.path.startsWith(`${candidate}/`),
    );
    if (root === undefined) continue;
    const list = grouped.get(root) ?? [];
    list.push(file);
    grouped.set(root, list);
  }

  // 3. Score dialect per root and emit classifications (or an ambiguity diagnostic).
  const classified = new Map<string, FileClassification>();
  const diagnostics: ExtractDiagnostic[] = [];
  for (const [root, members] of grouped) {
    let mule3 = 0;
    let mule4 = 0;
    for (const file of members) {
      const text = textByPath.get(file.path) ?? '';
      if (file.path.endsWith('mule-artifact.json')) mule4 += 3;
      if (/<packaging>mule-application<\/packaging>/.test(text)) mule4 += 3;
      if (file.path.includes('/src/main/mule/')) mule4 += 2;
      if (file.path.includes('/src/test/munit/')) mule4 += 2;
      if (file.path.endsWith('mule-project.xml')) mule3 += 3;
      if (file.path.includes('/src/main/app/')) mule3 += 3;
      if (/<packaging>mule-domain<\/packaging>/.test(text)) mule3 += 2;
      if (MULE3_XML_SIGNALS.some((re) => re.test(text))) mule3 += 2;
    }
    const projectId = root || '.';
    if (mule3 > 0 && mule4 > 0 && Math.abs(mule3 - mule4) < 3) {
      diagnostics.push({
        code: 'mule:ambiguous-dialect',
        severity: 'error',
        message: `Conflicting Mule dialect signals under ${projectId}`,
        projectId,
      });
      continue;
    }
    if (mule3 === 0 && mule4 === 0) continue;
    const dialect: FileClassification['dialect'] = mule4 > mule3 ? 'mule4' : 'mule3';
    for (const file of members) {
      const role = roleOf(file.path);
      classified.set(file.path, {
        family: 'mule',
        projectId,
        projectRoot: root,
        dialect,
        role,
        ...(role === 'properties' && SENSITIVE_NAME.test(file.path) ? { sensitive: true } : {}),
      });
    }
  }
  return { files: classified, diagnostics };
}
