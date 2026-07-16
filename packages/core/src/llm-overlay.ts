/**
 * Read-only view of `.crib/graph/semantic` — a lean overlay of every saved LLM artifact keyed by
 * targetId, carrying just the surfaced fields (name, purpose, confidence, staleness, mode) the
 * functional map and the viz need to label modules/clusters WITHOUT paying the multi-KB
 * analysis+graph+evidence blob cost. The EnrichmentStore stays the only writer; this module never
 * persists. Staleness is computed from the live soul so the overlay self-invalidates for free and
 * survives a re-index (artifacts are keyed by membership-stable target id, not by hash).
 *
 * Deliberate deviation from soul write-back: surfacing LLM cluster labels via this read-time
 * overlay (instead of stamping `meta.llmLabel` onto cluster nodes) avoids `soul.commit()` from the
 * MCP server, which would churn `stats.lastUpdated` and break the `cache:stability` byte-stability
 * gate. Same user-visible result; staleness for free.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clusterContentHash } from './cluster-hash.js';
import { graphPaths } from './graph-layout.js';
import type { SoulStore } from './soul-store.js';

/** The four LLM enrichment layers (mirrors `mcp/enrichment.ts:EnrichLayer`; duplicated here so core
 *  never imports mcp). */
export type LlmLayer = 'symbol' | 'file' | 'cluster' | 'system';

export interface LlmOverlayEntry {
  targetId: string;
  layer: LlmLayer;
  /** LLM-authored display name (cluster label / module name). Undefined when the artifact didn't
   *  surface one — consumers fall back to the heuristic label. */
  name?: string;
  /** One-line purpose from the analysis. */
  purpose?: string;
  confidence?: number;
  /** True when the live soul no longer matches the artifact's hash (content drifted) or the schema
   *  version bumped. */
  stale: boolean;
  /** `'skeleton'` for the draft system bible, `'full'` for the real pass; absent = full (legacy). */
  mode?: 'skeleton' | 'full';
}

export interface LlmOverlay {
  /** Per-target overlay entries (the latest artifact per targetId). */
  entries: Map<string, LlmOverlayEntry>;
  /** True if a fresh (non-stale) system artifact exists — the system-bible presence signal. */
  hasFreshSystem: boolean;
  /** The system entry, if any (skeleton or full). */
  system?: LlmOverlayEntry;
}

interface ReadArtifact {
  layer: LlmLayer;
  targetId: string;
  nodeHash: string;
  schemaVersion: string;
  purpose?: string;
  name?: string;
  confidence?: number;
  mode?: 'skeleton' | 'full';
}

/** Read semantic overlay. `opts.includeStale` (default true) controls whether
 *  stale artifacts appear in the entries map (the viz wants them for fade-rendering; the functional
 *  map's purpose resolution only consumes fresh ones, filtering inline). */
export function readLlmOverlay(soul: SoulStore, opts: { includeStale?: boolean } = {}): LlmOverlay {
  const includeStale = opts.includeStale ?? true;
  const canonical = graphPaths(soul.cribDir);
  const legacyRoot = join(soul.cribDir, 'llm');
  const analysisDir = existsSync(canonical.artifacts)
    ? canonical.artifacts
    : join(legacyRoot, 'analysis');
  const manifestSchema = soul.getManifest().schemaVersion;
  const vcsHead = soul.getManifest().repo.vcsHead ?? null;
  const llmManifest = readJson<{ builtAgainstHead?: string | null }>(
    existsSync(canonical.state) ? canonical.state : join(legacyRoot, 'manifest.json'),
  );

  const raw = existsSync(analysisDir) ? readAllArtifacts(analysisDir) : [];

  // Keep the newest artifact per targetId (a re-save with a new hash coexists briefly; prefer the
  // one whose nodeHash matches the live hash, else the last by sort).
  const byTarget = new Map<string, ReadArtifact>();
  for (const a of raw) {
    const prev = byTarget.get(a.targetId);
    if (!prev) {
      byTarget.set(a.targetId, a);
      continue;
    }
    // Prefer a schema-version match, then the lexicographically-later nodeHash (newer content).
    if (
      a.schemaVersion === manifestSchema ||
      (a.nodeHash > prev.nodeHash && prev.schemaVersion !== manifestSchema)
    ) {
      byTarget.set(a.targetId, a);
    }
  }

  const entries = new Map<string, LlmOverlayEntry>();
  let hasFreshSystem = false;
  let system: LlmOverlayEntry | undefined;
  for (const a of byTarget.values()) {
    const stale = isStale(soul, a, manifestSchema, vcsHead, llmManifest?.builtAgainstHead ?? null);
    if (stale && !includeStale) continue;
    const entry: LlmOverlayEntry = {
      targetId: a.targetId,
      layer: a.layer,
      stale,
      ...(a.name ? { name: a.name } : {}),
      ...(a.purpose ? { purpose: a.purpose } : {}),
      ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
      ...(a.mode ? { mode: a.mode } : {}),
    };
    entries.set(a.targetId, entry);
    if (a.layer === 'system') {
      system = entry;
      if (!stale) hasFreshSystem = true;
    }
  }
  return { entries, hasFreshSystem, ...(system ? { system } : {}) };
}

/** Staleness for one artifact — mirrors `EnrichmentStore.isStale` for symbol/file/cluster, and uses
 *  the manifest head (the cheap path) for the system layer. */
function isStale(
  soul: SoulStore,
  a: ReadArtifact,
  schemaVersion: string,
  vcsHead: string | null,
  llmBuiltAgainstHead: string | null,
): boolean {
  if (a.schemaVersion !== schemaVersion) return true;
  if (a.layer === 'system') {
    // No vcsHead to compare (non-git repo) → trust the artifact unless the schema bumped.
    if (vcsHead === null && llmBuiltAgainstHead === null) return false;
    return vcsHead !== llmBuiltAgainstHead;
  }
  const node = soul.getNode(a.targetId);
  if (!node) return true;
  if (a.layer === 'cluster') return clusterContentHash(soul, node) !== a.nodeHash;
  return node.hash !== a.nodeHash;
}

function readAllArtifacts(analysisDir: string): ReadArtifact[] {
  const out: ReadArtifact[] = [];
  for (const file of walkJson(analysisDir)) {
    const json = readJson<Record<string, unknown>>(file);
    if (!json || typeof json.layer !== 'string' || typeof json.targetId !== 'string') continue;
    const analysis = (json.analysis as Record<string, unknown> | undefined) ?? {};
    out.push({
      layer: json.layer as LlmLayer,
      targetId: json.targetId as string,
      nodeHash: typeof json.nodeHash === 'string' ? json.nodeHash : '',
      schemaVersion: typeof json.schemaVersion === 'string' ? json.schemaVersion : '',
      ...(typeof analysis.purpose === 'string' ? { purpose: analysis.purpose } : {}),
      ...(typeof analysis.name === 'string' ? { name: analysis.name } : {}),
      ...(typeof analysis.confidence === 'number' ? { confidence: analysis.confidence } : {}),
      ...(json.mode === 'skeleton' || json.mode === 'full' ? { mode: json.mode } : {}),
    });
  }
  return out;
}

function walkJson(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) out.push(...walkJson(path));
    else if (name.name.endsWith('.json')) out.push(path);
  }
  return out;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
