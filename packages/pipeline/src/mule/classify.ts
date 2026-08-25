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

/** True if `path` contains the directory `segment` as a path component — at the start of the path
 *  or after a leading slash — so a repo-root file (`src/test/munit/suite.xml`, no leading slash)
 *  and a nested-root file (`legacy/src/test/munit/order-test.xml`) both match `src/test/munit`.
 *  Plain `.includes('/src/test/munit/')` (leading slash) misses the repo-root case: a Mule project
 *  indexed at its own root (`crib index <project-dir>`) has projectRoot `''`, so every file path
 *  lacks the leading slash and MUnit files would misclassify as `config` instead of `munit`. */
function hasSegment(path: string, segment: string): boolean {
  return path === segment || path.startsWith(`${segment}/`) || path.includes(`/${segment}/`);
}

/** JAR-packaging prefixes that mark a config as a build copy rather than the canonical source.
 *  A deployable Mule JAR carries the original config tree under `META-INF/mule-src` (attached
 *  source) and a packaged copy under `classes/`; only the attached source is semantically
 *  extracted (see {@link dedupAttachedSource}). */
const PACKAGED_PREFIX = 'classes/';
const ATTACHED_PREFIX = 'META-INF/mule-src/';

/** Mule source-tree segments (with and without the `src/` qualifier) stripped when keying a config
 *  so a packaged copy and its attached-source original converge to the same logical path. */
const SOURCE_TREE_SEGMENTS = [
  'src/main/mule/',
  'src/main/app/',
  'src/test/munit/',
  'main/mule/',
  'main/app/',
  'test/munit/',
] as const;

/** Normalize a config path to its project-relative logical key by stripping the JAR-packaging
 *  prefix (`classes/` or `META-INF/mule-src/`) and a leading Mule source-tree segment. A packaged
 *  `classes/api.xml` and its attached source `META-INF/mule-src/main/mule/api.xml` both reduce to
 *  `api.xml`. Paths carrying neither packaging prefix are returned unchanged (not deduped). */
function logicalConfigKey(path: string): string {
  let p = path;
  if (p.startsWith(ATTACHED_PREFIX)) p = p.slice(ATTACHED_PREFIX.length);
  else if (p.startsWith(PACKAGED_PREFIX)) p = p.slice(PACKAGED_PREFIX.length);
  for (const seg of SOURCE_TREE_SEGMENTS) {
    if (p.startsWith(seg)) return p.slice(seg.length);
  }
  return p;
}

/** True for the semantic XML roles that participate in attached-source dedup (config flows +
 *  MUnit tests). Descriptors, properties, DataWeave, and RAML are out of scope: the spec dedups
 *  "packaged XML" configs, and descriptors must stay classified to anchor a JAR's dialect. */
function isDedupRole(role: FileClassification['role']): boolean {
  return role === 'config' || role === 'munit';
}

/** For one project's members, return the set of packaged `classes/` paths whose attached-source
 *  original is also present (attached source wins). Emits one bounded warning per skipped path. */
function dedupAttachedSource(
  members: FileMeta[],
  projectId: string,
  diagnostics: ExtractDiagnostic[],
): Set<string> {
  // logicalKey → { attached present?, packaged paths }
  const byKey = new Map<string, { attached: boolean; packaged: string[] }>();
  for (const file of members) {
    if (!isDedupRole(roleOf(file.path))) continue;
    const isAttached = file.path.startsWith(ATTACHED_PREFIX);
    const isPackaged = file.path.startsWith(PACKAGED_PREFIX);
    if (!isAttached && !isPackaged) continue;
    const key = logicalConfigKey(file.path);
    const slot = byKey.get(key) ?? { attached: false, packaged: [] };
    if (isAttached) slot.attached = true;
    else slot.packaged.push(file.path);
    byKey.set(key, slot);
  }
  const skip = new Set<string>();
  for (const { attached, packaged } of byKey.values()) {
    if (!attached || packaged.length === 0) continue;
    for (const path of packaged) {
      skip.add(path);
      diagnostics.push({
        code: 'mule:packaged-duplicate-skipped',
        severity: 'warning',
        message: `Skipped packaged duplicate ${path}; attached source wins`,
        file: path,
        projectId,
      });
    }
  }
  return skip;
}

const roleOf = (path: string): FileClassification['role'] => {
  const lower = path.toLowerCase();
  if (hasSegment(lower, 'src/test/munit') && lower.endsWith('.xml')) return 'munit';
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
      if (hasSegment(file.path, 'src/main/mule')) mule4 += 2;
      if (hasSegment(file.path, 'src/test/munit')) mule4 += 2;
      if (file.path.endsWith('mule-project.xml')) mule3 += 3;
      if (hasSegment(file.path, 'src/main/app')) mule3 += 3;
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
    // Deployable-JAR attached-source dedup: drop packaged `classes/` configs whose
    // `META-INF/mule-src` original is present (attached source wins), with a bounded warning.
    const skip = dedupAttachedSource(members, projectId, diagnostics);
    for (const file of members) {
      if (skip.has(file.path)) continue;
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
