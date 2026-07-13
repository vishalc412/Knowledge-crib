import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';

const MAX_SOURCE_LINES = 200;
const MAX_SOURCE_CHARS = 64 * 1024;

export class VizHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface VizSourceResponse {
  nodeId: string;
  file: string;
  span: { start: number; end: number };
  excerpt: { start: number; end: number; text: string; truncated: boolean };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Read source only through an indexed node id. Raw client paths are never accepted. */
export async function readVizNodeSource(
  soul: SoulStore,
  repoRoot: string,
  nodeId: string,
): Promise<VizSourceResponse> {
  const node = soul.getNode(nodeId);
  if (!node) throw new VizHttpError(404, `unknown node: ${nodeId}`);
  if (!node.file || !node.span)
    throw new VizHttpError(422, `source location unavailable: ${nodeId}`);

  let rootReal: string;
  let sourceReal: string;
  try {
    rootReal = await realpath(repoRoot);
    sourceReal = await realpath(resolve(rootReal, node.file));
  } catch {
    throw new VizHttpError(404, `source file not found: ${node.file}`);
  }
  if (!isInside(rootReal, sourceReal)) {
    throw new VizHttpError(403, 'source path escapes repository root');
  }

  const source = await readFile(sourceReal, 'utf8');
  const lines = source.split(/\r?\n/);
  const requestedStart = Math.max(1, Math.trunc(node.span.start));
  const requestedEnd = Math.max(requestedStart, Math.trunc(node.span.end));
  const start = Math.min(requestedStart, Math.max(1, lines.length));
  const lineCappedEnd = Math.min(requestedEnd, start + MAX_SOURCE_LINES - 1, lines.length);
  let text = lines.slice(start - 1, lineCappedEnd).join('\n');
  let truncated = lineCappedEnd < requestedEnd;
  if (text.length > MAX_SOURCE_CHARS) {
    text = text.slice(0, MAX_SOURCE_CHARS);
    truncated = true;
  }

  return {
    nodeId,
    file: node.file,
    span: { ...node.span },
    excerpt: { start, end: lineCappedEnd, text, truncated },
  };
}

/** Resolve static viz assets with traversal and symlink containment checks. */
export async function resolveVizAsset(assetsRoot: string, pathname: string): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new VizHttpError(400, 'malformed asset path');
  }
  const rel = decoded.replace(/^\/+/, '') || 'index.html';
  let rootReal: string;
  let assetReal: string;
  try {
    rootReal = await realpath(assetsRoot);
    assetReal = await realpath(resolve(rootReal, rel));
  } catch {
    throw new VizHttpError(404, 'asset not found');
  }
  if (!isInside(rootReal, assetReal)) throw new VizHttpError(403, 'asset path escapes viz root');
  return assetReal;
}
