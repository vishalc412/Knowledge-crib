/** Canonical `.crib/graph` layout and guarded legacy migration. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const GRAPH_DIR = 'graph';
export const GRAPH_MANIFEST = join(GRAPH_DIR, 'manifest.json');
export const EXTRACTED_DIR = join(GRAPH_DIR, 'extracted');
export const SEMANTIC_DIR = join(GRAPH_DIR, 'semantic');

export interface GraphPaths {
  root: string;
  manifest: string;
  extracted: string;
  nodes: string;
  edges: string;
  clusters: string;
  semantic: string;
  artifacts: string;
  aliases: string;
  state: string;
}

export function graphPaths(cribDir: string): GraphPaths {
  const root = join(cribDir, GRAPH_DIR);
  const extracted = join(cribDir, EXTRACTED_DIR);
  const semantic = join(cribDir, SEMANTIC_DIR);
  return {
    root,
    manifest: join(cribDir, GRAPH_MANIFEST),
    extracted,
    nodes: join(extracted, 'nodes'),
    edges: join(extracted, 'edges'),
    clusters: join(extracted, 'clusters', 'clusters.jsonl'),
    semantic,
    artifacts: join(semantic, 'artifacts'),
    aliases: join(semantic, 'aliases.json'),
    state: join(semantic, 'state.json'),
  };
}

export function hasCanonicalGraph(cribDir: string): boolean {
  return existsSync(graphPaths(cribDir).manifest);
}

export function hasLegacyGraph(cribDir: string): boolean {
  return ['nodes', 'edges', 'clusters', 'llm'].some((name) => existsSync(join(cribDir, name)));
}

export interface GraphMigrationReport {
  needed: boolean;
  dryRun: boolean;
  moved: string[];
  removedDerivedProjections: number;
}

/**
 * Stage legacy graph stores, validate copied roots, then atomically activate `.crib/graph`.
 * Legacy roots are removed only after activation. Callers must hold the crib lock.
 */
export function migrateLegacyGraph(cribDir: string, dryRun = false): GraphMigrationReport {
  if (hasCanonicalGraph(cribDir)) {
    return { needed: false, dryRun, moved: [], removedDerivedProjections: 0 };
  }
  const moved = ['nodes', 'edges', 'clusters', 'llm'].filter((name) =>
    existsSync(join(cribDir, name)),
  );
  if (moved.length === 0) {
    return { needed: false, dryRun, moved: [], removedDerivedProjections: 0 };
  }
  if (dryRun) return { needed: true, dryRun: true, moved, removedDerivedProjections: 0 };

  const paths = graphPaths(cribDir);
  const staging = `${paths.root}.migrate-${process.pid}`;
  const bootstrapTmp = join(cribDir, `crib.json.migrate-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  rmSync(bootstrapTmp, { force: true });
  try {
    const extracted = join(staging, 'extracted');
    for (const name of ['nodes', 'edges', 'clusters']) {
      const src = join(cribDir, name);
      if (existsSync(src)) cpSync(src, join(extracted, name), { recursive: true });
    }

    const legacyLlm = join(cribDir, 'llm');
    const semantic = join(staging, 'semantic');
    let removedDerivedProjections = 0;
    if (existsSync(legacyLlm)) {
      const analysis = join(legacyLlm, 'analysis');
      if (existsSync(analysis)) cpSync(analysis, join(semantic, 'artifacts'), { recursive: true });
      for (const [legacy, canonical] of [
        ['aliases.json', 'aliases.json'],
        ['manifest.json', 'state.json'],
      ] as const) {
        const src = join(legacyLlm, legacy);
        if (existsSync(src)) {
          mkdirSync(semantic, { recursive: true });
          cpSync(src, join(semantic, canonical));
        }
      }
      // overview + graph projections are derived from canonical semantic artifacts.
      removedDerivedProjections = countFiles(join(legacyLlm, 'graph'));
    }

    const legacyManifest = join(cribDir, 'crib.json');
    if (!existsSync(legacyManifest)) throw new Error('legacy graph has no crib.json manifest');
    const manifest = JSON.parse(readFileSync(legacyManifest, 'utf8')) as Record<string, unknown>;
    const stores = (manifest.stores ?? {}) as Record<string, unknown>;
    manifest.stores = { ...stores, graph: { path: '.crib/graph', format: 'layered-jsonl' } };
    const previousGeneration = (manifest.generation ?? {}) as {
      extracted?: number;
      semantic?: number;
    };
    manifest.generation = {
      extracted: Math.max(1, previousGeneration.extracted ?? 0),
      semantic: Math.max(
        countFiles(join(staging, 'semantic', 'artifacts')) > 0 ? 1 : 0,
        previousGeneration.semantic ?? 0,
      ),
    };
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    validateStaging(staging, manifest);
    const repo = (manifest.repo ?? {}) as Record<string, unknown>;
    writeFileSync(
      bootstrapTmp,
      `${JSON.stringify(
        {
          cribFormatVersion: manifest.cribFormatVersion,
          repo: { id: repo.id, root: repo.root },
          stores: { graph: (manifest.stores as Record<string, unknown>).graph },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    mkdirSync(dirname(paths.root), { recursive: true });
    renameSync(staging, paths.root);
    try {
      renameSync(bootstrapTmp, legacyManifest);
    } catch (error) {
      // Activation is incomplete: restore legacy authority before reporting failure.
      rmSync(paths.root, { recursive: true, force: true });
      throw error;
    }
    for (const name of moved) rmSync(join(cribDir, name), { recursive: true, force: true });
    return { needed: true, dryRun: false, moved, removedDerivedProjections };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(bootstrapTmp, { force: true });
    throw error;
  }
}

function validateStaging(staging: string, manifest: Record<string, unknown>): void {
  const manifestPath = join(staging, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('staged graph manifest missing');
  const stats = (manifest.stats ?? {}) as { nodes?: number; edges?: number };
  const extracted = join(staging, 'extracted');
  const nodeCount =
    countJsonlRecords(join(extracted, 'nodes')) + countJsonlRecords(join(extracted, 'clusters'));
  const edgeCount = countJsonlRecords(join(extracted, 'edges'));
  if (typeof stats.nodes === 'number' && nodeCount !== stats.nodes) {
    throw new Error(`staged node count mismatch: manifest=${stats.nodes}, files=${nodeCount}`);
  }
  if (typeof stats.edges === 'number' && edgeCount !== stats.edges) {
    throw new Error(`staged edge count mismatch: manifest=${stats.edges}, files=${edgeCount}`);
  }
  const artifacts = join(staging, 'semantic', 'artifacts');
  for (const file of walkFiles(artifacts).filter((path) => path.endsWith('.json'))) {
    const artifact = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (
      typeof artifact.targetId !== 'string' ||
      typeof artifact.nodeHash !== 'string' ||
      typeof artifact.schemaVersion !== 'string' ||
      typeof artifact.graph !== 'object'
    ) {
      throw new Error(`invalid semantic artifact: ${file}`);
    }
  }
}

function countJsonlRecords(root: string): number {
  let count = 0;
  for (const file of walkFiles(root).filter((path) => path.endsWith('.jsonl'))) {
    count += readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  }
  return count;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of requireEntries(dir)) {
      if (entry.directory) stack.push(entry.path);
      else files.push(entry.path);
    }
  }
  return files;
}

function countFiles(root: string): number {
  if (!existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of requireEntries(dir)) {
      if (entry.directory) stack.push(entry.path);
      else count++;
    }
  }
  return count;
}

function requireEntries(dir: string): Array<{ path: string; directory: boolean }> {
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    return { path, directory: statSync(path).isDirectory() };
  });
}
