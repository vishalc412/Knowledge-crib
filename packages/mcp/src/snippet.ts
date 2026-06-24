/**
 * Snippet rehydration: text is referenced (file + span), never copied into the soul, so verbs read
 * the first meaningful line of a node's span on demand. Falls back to the edge evidence snippet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';

const MAX_SNIPPET = 160;

/** First non-blank line of `node`'s span, trimmed to MAX_SNIPPET chars; '' if unavailable. */
export function rehydrate(repoRoot: string, node: Node | undefined): string {
  if (!node?.file || !node.span) return '';
  try {
    const lines = readFileSync(join(repoRoot, node.file), 'utf8').split('\n');
    for (let i = node.span.start - 1; i < node.span.end && i < lines.length; i++) {
      const line = (lines[i] ?? '').trim().replace(/^#+\s*/, '');
      if (line.length > 0) return line.slice(0, MAX_SNIPPET);
    }
  } catch {
    // fall through
  }
  return '';
}
