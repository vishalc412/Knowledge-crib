/**
 * sbom — produce a CycloneDX SBOM for the release artifacts, and assert its structural invariants.
 *
 * Plan requirement (developer-trust-plan.md §WP3, bullet 6): "Extend existing dependency updates
 * with dependency-risk, license, secret, and release-artifact checks. Produce an SBOM for release
 * artifacts." This is the fourth of those four and the SBOM itself; `credential-check.mjs`,
 * `license-check.mjs` and `dep-risk-check.mjs` are its siblings.
 *
 * WHAT THIS IS: a component inventory with licenses, built from what is actually INSTALLED —
 * `pnpm licenses list --json` for the external components and their license expressions,
 * `pnpm list -r --json --depth Infinity` for the workspace packages and the edges between them.
 * Both are local reads; no network is touched.
 *
 * WHY IT IS LABELLED "lockfile-derived". An SBOM's value depends on a reader knowing what it was
 * built from. This one describes the dependency tree the lockfile resolves, not the bytes of a
 * published tarball: it is derived from manifests and the installed tree, and it is NOT a hash
 * manifest of the shipped files. A reader who needs to tie an artifact to a set of exact bytes needs
 * a different document, and this one says so rather than implying it by being called an SBOM.
 * `release-evidence.json` is where artifact digests live.
 *
 * WHAT THIS IS NOT, stated here so the limit is a known one rather than a silent one:
 *   - It does NOT validate against the official CycloneDX JSON schema. That schema is not vendored
 *     here, and a network fetch during a release gate would make the gate depend on the network for
 *     a check it does not need. Instead the STRUCTURAL INVARIANTS the format requires are asserted
 *     below — every component identifiable, every reference resolvable, no duplicate identity — and
 *     the `$schema` is emitted so a consumer can validate independently. An invariant check is not
 *     the schema check, and this comment is the record of that gap.
 *   - It does not see vulnerabilities. Findings are `dep-risk-check.mjs`'s job; this document
 *     describes what is present, not what is wrong with it.
 *   - It does not see a dependency that is declared but not installed, nor one present only in a
 *     git ref that no importer resolves.
 *
 * DETERMINISM. Two runs over the same tree must produce the same document — a release artifact that
 * changes when nothing changed cannot be compared, archived, or diffed. So: every list is sorted; the
 * `serialNumber` is derived from a hash of the component set rather than sampled at random; and the
 * one genuinely time-varying field is `metadata.timestamp`, which is pinned by `SOURCE_DATE_EPOCH`
 * when it is set (the reproducible-builds convention). It is the ONLY field that differs between two
 * runs of an unchanged tree, and it is named here so that fact is not a surprise.
 *
 * Usage:  node scripts/sbom.mjs [--root <dir>] [--out <file>] [--stdout] [--json]
 *   Default output: ./sbom.cdx.json (gitignored, like release-evidence.json — running the gate
 *   locally must not dirty the checkout it certifies).
 * Exit 0 = the SBOM was produced and every invariant held; 1 = an invariant failed (nothing is
 * written, so a broken document is never mistaken for a release artifact); 2 = could not read inputs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const REPO = resolve(flagValue('--root') ?? join(__dirname, '..'));
const JSON_OUT = argv.includes('--json');
const TO_STDOUT = argv.includes('--stdout');
const OUT_PATH = resolve(flagValue('--out') ?? join(REPO, 'sbom.cdx.json'));
const LICENSES_FILE = flagValue('--licenses');
const TREE_FILE = flagValue('--tree');

const SPEC_VERSION = '1.5';
const SCHEMA_URL = `http://cyclonedx.org/schema/bom-${SPEC_VERSION}.schema.json`;

const failures = [];
const fail = (detail) => failures.push(detail);

/**
 * A package URL per the purl spec: the scope is a NAMESPACE, so `@scope/name` becomes
 * `pkg:npm/%40scope/name` — the `@` is percent-encoded and the `/` is a literal separator. Encoding
 * the slash too (or leaving the `@` bare) produces a purl that does not resolve.
 */
function purl(name, version) {
  if (name.startsWith('@')) {
    const [scope, bare] = name.split('/');
    return `pkg:npm/${encodeURIComponent(scope)}/${bare}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/** Deterministic UUID derived from the component set, so two runs of one tree agree. */
function deterministicUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex');
  const chars = hex.slice(0, 32).split('');
  chars[12] = '5'; // version 5 (name-based) — honest: this IS a name-derived UUID
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const s = chars.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ─── inputs ──────────────────────────────────────────────────────────────────────────────────────

function pnpmJson(args, injected) {
  if (injected) {
    // An injected document that does not parse is UNAVAILABLE, exactly like a pnpm invocation that
    // failed: both mean an input could not be read, and neither is a statement about the tree.
    const source = `--${args.flag} ${injected}`;
    try {
      return { source, doc: readJson(injected) };
    } catch (error) {
      return { source, doc: null, unavailable: true, detail: error?.message ?? 'unparseable' };
    }
  }
  const label = `pnpm ${args.label}`;
  try {
    return {
      source: label,
      doc: JSON.parse(
        execFileSync('corepack', ['pnpm@9.15.0', ...args.argv], {
          cwd: REPO,
          encoding: 'utf8',
          maxBuffer: 128 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
          // corepack ships as a .cmd shim on Windows, which execFileSync cannot launch without a shell.
          shell: process.platform === 'win32',
        }),
      ),
    };
  } catch (error) {
    return { source: label, doc: null, unavailable: true, detail: error?.message };
  }
}

const licenses = pnpmJson(
  { flag: 'licenses', label: 'licenses list --json', argv: ['licenses', 'list', '--json'] },
  LICENSES_FILE,
);
const tree = pnpmJson(
  {
    flag: 'tree',
    label: 'list -r --json --depth Infinity',
    argv: ['list', '-r', '--json', '--depth', 'Infinity'],
  },
  TREE_FILE,
);

/** A malformed input is UNAVAILABLE, with the shape mismatch named — never a crash mid-render. */
function assertShape(doc, kind) {
  if (kind === 'licenses') {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return 'expected an object mapping each license expression to an array of packages';
    }
    for (const [expression, packages] of Object.entries(doc)) {
      if (!Array.isArray(packages))
        return `the value for "${expression}" is not an array of packages`;
      for (const entry of packages) {
        if (!entry || typeof entry.name !== 'string')
          return `a package under "${expression}" has no name`;
      }
    }
    return null;
  }
  if (!Array.isArray(doc)) {
    return 'expected an array of workspace entries, one per package';
  }
  return null;
}

let rootManifest;
try {
  rootManifest = readJson(join(REPO, 'package.json'));
} catch (error) {
  rootManifest = null;
  failures.push(`could not read the root package.json: ${error.message}`);
}

const licensesShape = licenses.unavailable ? null : assertShape(licenses.doc, 'licenses');
const treeShape = tree.unavailable ? null : assertShape(tree.doc, 'tree');
if (licensesShape) licenses.unavailable = true;
if (treeShape) tree.unavailable = true;

if (licenses.unavailable || tree.unavailable || !rootManifest) {
  const which = [
    licenses.unavailable ? `${licenses.source}${licensesShape ? ` (${licensesShape})` : ''}` : null,
    tree.unavailable ? `${tree.source}${treeShape ? ` (${treeShape})` : ''}` : null,
    rootManifest ? null : 'package.json',
  ]
    .filter(Boolean)
    .join(', ');
  process.stdout.write(`sbom: UNAVAILABLE — could not read ${which}\n`);
  process.exitCode = 2;
} else {
  // ─── components ────────────────────────────────────────────────────────────────────────────────

  const components = [];
  const externalNames = new Set();
  for (const [expression, packages] of Object.entries(licenses.doc)) {
    for (const entry of packages) {
      externalNames.add(entry.name);
      for (const version of entry.versions ?? []) {
        const licence = entry.license ?? expression;
        const component = {
          type: 'library',
          'bom-ref': purl(entry.name, version),
          name: entry.name,
          version,
          purl: purl(entry.name, version),
          scope: 'required',
        };
        // An SPDX expression with an operator is emitted as `expression`; a bare id as `id`.
        if (/\s(?:AND|OR|WITH)\s|[()]/.test(licence)) {
          component.licenses = [{ expression: licence }];
        } else {
          component.licenses = [{ license: { id: licence } }];
        }
        if (entry.homepage)
          component.externalReferences = [{ type: 'website', url: entry.homepage }];
        components.push(component);
      }
    }
  }

  // Workspace packages. Resolved from the tree rather than assumed, so a package that stops being
  // published stops appearing here without anyone editing a list.
  const workspace = [];
  for (const entry of tree.doc) {
    if (!entry.name || !entry.version || !entry.path) continue;
    if (!entry.path.startsWith(REPO)) continue;
    if (entry.private === true && entry.path === REPO) continue; // the private root is the subject
    if (externalNames.has(entry.name)) continue; // a workspace name that shadows a published one
    workspace.push(entry);
  }
  const workspaceByName = new Map(workspace.map((entry) => [entry.name, entry]));
  for (const entry of workspace) {
    // The license comes from the package's OWN manifest, not from a list here: a dependency entry
    // that ages against the manifest is worse than no entry. A manifest without one stays without
    // one, and invariant I3 below fails on it — which is the correct outcome, not a gap to paper over.
    let manifest = null;
    try {
      manifest = readJson(join(entry.path, 'package.json'));
    } catch {
      manifest = null;
    }
    const licence = manifest?.license;
    const component = {
      type: 'library',
      'bom-ref': purl(entry.name, entry.version),
      name: entry.name,
      version: entry.version,
      purl: purl(entry.name, entry.version),
      scope: 'required',
      properties: [{ name: 'kb:workspacePath', value: relative(REPO, entry.path) }],
    };
    if (typeof licence === 'string' && licence) {
      component.licenses = /\s(?:AND|OR|WITH)\s|[()]/.test(licence)
        ? [{ expression: licence }]
        : [{ license: { id: licence } }];
    }
    components.push(component);
  }
  components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

  // ─── dependency graph ──────────────────────────────────────────────────────────────────────────
  //
  // The tree pnpm reports is per-importer, so the same package appears once under each path that
  // reaches it. The document wants one node per identity with the union of its edges, so this walks
  // the tree, resolves every node to a purl, and accumulates edges into sets.

  const nodeRef = (node) => {
    const name = node.from ?? node.name;
    if (!name) return null;
    let version = node.version;
    // A workspace link reports `link:../sibling`, not a version: resolve it to the real one.
    if (typeof version === 'string' && version.startsWith('link:')) {
      const linked = workspaceByName.get(name);
      if (!linked) return null;
      version = linked.version;
    }
    if (!version || !/^\d/.test(version)) return null;
    return purl(name, version);
  };

  const edges = new Map();
  const seen = new Set();
  const walk = (node, parentRef) => {
    const ref = nodeRef(node);
    if (!ref || seen.has(`${parentRef}->${ref}`)) return;
    seen.add(`${parentRef}->${ref}`);
    if (parentRef) {
      if (!edges.has(parentRef)) edges.set(parentRef, new Set());
      edges.get(parentRef).add(ref);
    }
    for (const child of Object.values(node.dependencies ?? {})) walk(child, ref);
  };
  for (const entry of tree.doc) {
    const ref = nodeRef({ ...entry, from: entry.name });
    if (ref) {
      if (!edges.has(ref)) edges.set(ref, new Set());
      for (const child of Object.values(entry.dependencies ?? {})) walk(child, ref);
    }
  }

  const rootComponent = {
    type: 'application',
    'bom-ref': purl(rootManifest.name, rootManifest.version),
    name: rootManifest.name,
    version: rootManifest.version,
    purl: purl(rootManifest.name, rootManifest.version),
  };

  const dependencyNodes = [...edges.entries()]
    .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  // ─── invariants ───────────────────────────────────────────────────────────────────────────────
  //
  // These are the structural requirements a CycloneDX consumer relies on. They are not the schema
  // (see the docblock), and a document that passes them is well-formed for the parts that are
  // checked, not schema-valid overall.

  const refs = new Set(components.map((c) => c['bom-ref']));
  const duplicateRefs = components.length - refs.size;
  if (duplicateRefs > 0) {
    fail(`I1: ${duplicateRefs} duplicate bom-ref(s) — an SBOM identity must be unique`);
  }
  for (const component of components) {
    if (!component.name || !component.version)
      fail(`I2: ${component['bom-ref']} is missing a name or version`);
    if (!component.licenses?.length)
      fail(
        `I3: ${component['bom-ref']} carries no license — a component with unknown terms must be visible as such`,
      );
  }
  // The primary component is the SUBJECT of the document, not one of its dependencies, so it is
  // deliberately absent from `components` — but it is a legitimate node in the graph, so its ref is
  // a known one for I4.
  const knownRefs = new Set([...refs, rootComponent['bom-ref']]);
  for (const node of dependencyNodes) {
    if (!knownRefs.has(node.ref)) fail(`I4: dependency node ${node.ref} has no matching component`);
    for (const target of node.dependsOn) {
      if (!knownRefs.has(target))
        fail(`I4: ${node.ref} depends on ${target}, which has no matching component`);
    }
  }
  if (components.length === 0) {
    fail('I5: the component list is EMPTY — a document describing nothing is not a valid SBOM');
  }

  const serialSeed = components.map((c) => c['bom-ref']).join('\n');
  const timestamp = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();

  const bom = {
    $schema: SCHEMA_URL,
    bomFormat: 'CycloneDX',
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${deterministicUuid(serialSeed)}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [
        { vendor: 'knowledge-crib', name: 'sbom.mjs', version: rootManifest.version ?? '0.0.0' },
      ],
      component: rootComponent,
      properties: [
        {
          name: 'kb:derivation',
          value:
            'pnpm-lock.yaml resolution + installed tree (not a hash manifest of published files)',
        },
        { name: 'kb:primaryComponent', value: 'workspace' },
      ],
    },
    components,
    dependencies: [
      {
        ref: rootComponent['bom-ref'],
        dependsOn: [...(edges.get(rootComponent['bom-ref']) ?? new Set())].sort(),
      },
      ...dependencyNodes.filter((node) => node.ref !== rootComponent['bom-ref']),
    ],
  };

  const rendered = `${JSON.stringify(bom, null, 2)}\n`;

  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root: REPO,
          out: TO_STDOUT ? null : relative(REPO, OUT_PATH),
          sources: { components: licenses.source, graph: tree.source },
          specVersion: SPEC_VERSION,
          serialNumber: bom.serialNumber,
          timestampPinned: Boolean(process.env.SOURCE_DATE_EPOCH),
          components: components.length,
          dependencyNodes: bom.dependencies.length,
          edges: dependencyNodes.reduce((n, node) => n + node.dependsOn.length, 0),
          bytes: Buffer.byteLength(rendered),
          failures,
        },
        null,
        1,
      )}\n`,
    );
  } else {
    const line = (label, value) => process.stdout.write(`  ${label.padEnd(34)} ${value}\n`);
    process.stdout.write('sbom\n');
    line('components via', licenses.source);
    line('graph via', tree.source);
    line('cyclonedx', `${SPEC_VERSION} (${SCHEMA_URL})`);
    line('serialNumber', bom.serialNumber);
    line(
      'timestamp',
      `${bom.metadata.timestamp}${process.env.SOURCE_DATE_EPOCH ? ' (pinned by SOURCE_DATE_EPOCH)' : ''}`,
    );
    line(
      'components (external/workspace)',
      `${components.length - workspace.length} / ${workspace.length}`,
    );
    line(
      'dependency nodes / edges',
      `${bom.dependencies.length} / ${dependencyNodes.reduce((n, node) => n + node.dependsOn.length, 0)}`,
    );
    line('bytes', Buffer.byteLength(rendered));
    if (failures.length) {
      process.stdout.write(`\nFAIL — ${failures.length} invariant(s):\n`);
      for (const detail of failures) process.stdout.write(`  ${detail}\n`);
    } else {
      process.stdout.write(`\nPASS — ${relative(REPO, OUT_PATH)} written; all invariants held\n`);
    }
  }

  if (failures.length) {
    // Nothing is written on failure: a document that failed its own invariants must not be left on
    // disk where a later step would pick it up as a release artifact.
    process.exitCode = 1;
  } else if (TO_STDOUT) {
    process.stdout.write(rendered);
  } else {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, rendered);
  }
}
