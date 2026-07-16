/**
 * Manifest (`.crib/crib.json`) read/write + a sane default for a fresh soul.
 *
 * The manifest is the soul's self-description: versions, repo id, chunking knobs, the index backend
 * pointer (reconciliation #7 — a concrete `{backend,path}` object, not a hardcoded `ladybug.db`
 * string), running stats, and capability flags.
 */
import { randomUUID } from 'node:crypto';
import {
  CRIB_FORMAT_VERSION,
  DEFAULT_CHUNKING,
  SCHEMA_VERSION,
  TOOL_NAME,
} from '@knowledge-crib/soul-schema';
import type { IndexBackend, Manifest, ManifestChunking } from '@knowledge-crib/soul-schema';

export interface NewManifestOpts {
  root?: string;
  repoId?: string;
  toolVersion?: string;
  chunking?: ManifestChunking;
  indexBackend?: IndexBackend;
  /** Fixed timestamp for deterministic tests; defaults to now. */
  now?: string;
}

/** A fresh manifest for a brand-new soul. */
export function newManifest(opts: NewManifestOpts = {}): Manifest {
  const backend: IndexBackend = opts.indexBackend ?? 'sqlite';
  return {
    cribFormatVersion: CRIB_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generation: { extracted: 0, semantic: 0 },
    repo: { id: opts.repoId ?? randomUUID(), root: opts.root ?? '.' },
    generator: { tool: TOOL_NAME, version: opts.toolVersion ?? '0.0.0' },
    chunking: opts.chunking ?? { ...DEFAULT_CHUNKING },
    stores: {
      soul: 'jsonl-chunked',
      graph: { path: '.crib/graph', format: 'layered-jsonl' },
      index: { backend, path: `.crib/index/crib.${backend === 'sqlite' ? 'sqlite' : 'kuzu'}` },
    },
    stats: {
      nodes: 0,
      edges: 0,
      clusters: 0,
      lastUpdated: opts.now ?? new Date().toISOString(),
    },
    capabilities: { embeddings: false, multimodal: false },
  };
}
